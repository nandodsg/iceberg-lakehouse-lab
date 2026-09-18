"""GA4 BigQuery Export -> bronze.

One export day = one load partition (`event_date`). The daily table
`events_YYYYMMDD` is the truth. The streaming table
`events_intraday_YYYYMMDD` (same day, not yet consolidated; BigQuery
reports 0 rows for it while a SELECT sees them) can be loaded under a
flag into the same partition, marked `_is_intraday = true`, and is
*replaced* — never summed — when the daily table is loaded. Loading
intraday over a partition that already holds the daily export is
refused unless forced.

The export's nested structure (event_params, user_properties, device,
geo, ...) is kept as Iceberg list/struct columns; on top of it the
extractor promotes `event_ts` (from `event_timestamp` microseconds) and
the user properties the configuration names (the population tag and one
column per experiment). The population policy runs here, before the
write, and its effect is counted in the manifest: rows with an allowed
population are kept; rows with no population at all are kept only when
their user id is known from another bronze source (a login fires before
the tag is attached); everything else is filtered out.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

import pyarrow as pa
import pyarrow.compute as pc
from pyiceberg.catalog import Catalog
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.expressions import EqualTo

from ..catalog import ensure_table
from ..config import Ga4BigQuerySource
from ..manifest import RunRecord, schema_hash

PROVENANCE = pa.schema(
    [
        pa.field("_source_table", pa.string(), nullable=False),
        pa.field("_is_intraday", pa.bool_(), nullable=False),
        pa.field("_source_watermark", pa.timestamp("us", tz="UTC")),
        pa.field("_ingestion_run_id", pa.string(), nullable=False),
        pa.field("_load_ts", pa.timestamp("us", tz="UTC"), nullable=False),
    ]
)

_DAY = re.compile(r"^(\d{4})-?(\d{2})-?(\d{2})$")


def normalize_day(day: str) -> str:
    """'2026-09-16' or '20260916' -> '20260916' (the export's suffix)."""
    m = _DAY.match(day.strip())
    if not m:
        raise ValueError(f"not a day: {day!r} (expected YYYYMMDD or YYYY-MM-DD)")
    y, mo, d = m.groups()
    datetime(int(y), int(mo), int(d))  # validates
    return f"{y}{mo}{d}"


def export_table(day: str, intraday: bool) -> str:
    return f"events_intraday_{day}" if intraday else f"events_{day}"


class SourceTableMissing(Exception):
    """The export table for that day does not exist (yet)."""


class IntradayOverDaily(Exception):
    """Refusing to replace a consolidated daily load with intraday rows."""


@dataclass
class Fetched:
    table: pa.Table
    source_table: str  # fully qualified
    bytes_processed: int | None = None
    job_id: str | None = None


Fetch = Callable[[Ga4BigQuerySource, str, bool], Fetched]


def fetch_bigquery(src: Ga4BigQuerySource, day: str, intraday: bool) -> Fetched:
    """Read one export table whole, as Arrow, through a query job (the
    Storage Read API alone would not see the intraday streaming buffer).
    Credentials: Application Default Credentials."""
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery

    client = bigquery.Client(project=src.project, location=src.location)
    name = f"{src.project}.{src.dataset}.{export_table(day, intraday)}"
    try:
        client.get_table(name)
    except NotFound as e:
        raise SourceTableMissing(f"no export table {name} (not exported yet, or already consolidated)") from e
    job = client.query(f"SELECT * FROM `{name}`")
    table = job.to_arrow()
    return Fetched(table=table, source_table=name, bytes_processed=job.total_bytes_processed, job_id=job.job_id)


def list_export_tables(src: Ga4BigQuerySource) -> list[dict[str, Any]]:
    """The dataset's `events_*` tables with their metadata (row count is
    0 for a table still in the streaming buffer)."""
    from google.cloud import bigquery

    client = bigquery.Client(project=src.project, location=src.location)
    out = []
    for t in client.list_tables(f"{src.project}.{src.dataset}"):
        if not t.table_id.startswith("events_"):
            continue
        tb = client.get_table(t.reference)
        intraday = t.table_id.startswith("events_intraday_")
        out.append(
            {
                "table": t.table_id,
                "day": t.table_id.rsplit("_", 1)[-1],
                "intraday": intraday,
                "rows": tb.num_rows,
                "bytes": tb.num_bytes,
                "streaming_buffer": tb.streaming_buffer is not None,
                "modified": tb.modified,
            }
        )
    return sorted(out, key=lambda r: (r["day"], r["intraday"]))


# ---- transform ------------------------------------------------------


def _user_property_columns(table: pa.Table, names: list[str]) -> dict[str, pa.Array]:
    """One string column per promoted user property (its `string_value`,
    last occurrence wins if a key repeats)."""
    values: dict[str, list[str | None]] = {n: [] for n in names}
    for props in table["user_properties"].to_pylist():
        found: dict[str, str | None] = {}
        for p in props or []:
            if p["key"] in values:
                found[p["key"]] = (p.get("value") or {}).get("string_value")
        for n in names:
            values[n].append(found.get(n))
    return {n: pa.array(v, pa.string()) for n, v in values.items()}


def promote(table: pa.Table, src: Ga4BigQuerySource) -> pa.Table:
    """Add `event_ts` and the promoted user-property columns. Promoted
    names must not shadow export columns."""
    names = list(src.promoted_user_properties)
    if src.population_property not in names:
        names.append(src.population_property)
    clash = [n for n in names + ["event_ts"] if n in table.column_names]
    if clash:
        raise ValueError(f"promoted column(s) would shadow export columns: {clash}")
    out = table.append_column(
        pa.field("event_ts", pa.timestamp("us", tz="UTC")),
        pc.cast(table["event_timestamp"], pa.timestamp("us", tz="UTC")),
    )
    for n, col in _user_property_columns(table, names).items():
        out = out.append_column(pa.field(n, pa.string()), col)
    return out


def apply_population_policy(
    table: pa.Table, src: Ga4BigQuerySource, known_users: set[str]
) -> tuple[pa.Table, dict[str, int]]:
    """Keep rows with an allowed population, or with no population and a
    known user id. Returns (kept, filtered-out counts by population)."""
    pop = table[src.population_property]
    uid = table["user_id"]
    allowed = pc.is_in(pop, value_set=pa.array(src.population_allow, pa.string()))
    known = pc.and_(pc.is_null(pop), pc.is_in(uid, value_set=pa.array(sorted(known_users), pa.string())))
    keep = pc.fill_null(pc.or_(allowed, known), False)
    dropped = table.filter(pc.invert(keep))
    counts = Counter("(null)" if v is None else v for v in dropped[src.population_property].to_pylist())
    return table.filter(keep), dict(sorted(counts.items()))


def known_user_ids(catalog: Catalog, namespace: str, src: Ga4BigQuerySource) -> tuple[set[str], dict[str, int]]:
    """Union of the configured id columns over the other bronze tables
    (missing tables contribute nothing — they may not be loaded yet)."""
    ids: set[str] = set()
    per_source: dict[str, int] = {}
    for ref in src.known_user_sources:
        try:
            t = catalog.load_table((namespace, ref.table))
        except NoSuchTableError:
            per_source[f"{ref.table}.{ref.column}"] = 0
            continue
        cols = (ref.column, ref.population_column) if ref.population_column else (ref.column,)
        rows = t.scan(selected_fields=cols).to_arrow()
        if ref.population_column:
            rows = rows.filter(
                pc.is_in(rows[ref.population_column], value_set=pa.array(src.population_allow, pa.string()))
            )
        found = {v for v in rows[ref.column].to_pylist() if v}
        per_source[f"{ref.table}.{ref.column}"] = len(found)
        ids |= found
    return ids, per_source


# ---- load -----------------------------------------------------------


def load_day(
    catalog: Catalog,
    namespace: str,
    src: Ga4BigQuerySource,
    day: str,
    run_id: str,
    *,
    intraday: bool = False,
    force: bool = False,
    fetch: Fetch = fetch_bigquery,
    known_users: tuple[set[str], dict[str, int]] | None = None,
) -> RunRecord:
    day = normalize_day(day)
    load_ts = datetime.now(timezone.utc)
    rec = RunRecord(run_id=run_id, source=src.kind, table_name=src.table, partition=day)

    # What the partition holds today: nothing, intraday rows, or the
    # daily export — never let intraday rows replace the latter.
    part = EqualTo("event_date", day)
    try:
        marks = catalog.load_table((namespace, src.table)).scan(row_filter=part, selected_fields=("_is_intraday",)).to_arrow()
    except NoSuchTableError:
        marks = None
    partition_loaded = marks is not None and marks.num_rows > 0
    if partition_loaded and intraday and not force and not pc.all(marks["_is_intraday"]).as_py():
        raise IntradayOverDaily(f"{src.table} partition {day} already holds the daily export; use --force to replace it")

    fetched = fetch(src, day, intraday)
    raw = fetched.table
    rec.rows_read = raw.num_rows

    known, per_source = known_users if known_users is not None else known_user_ids(catalog, namespace, src)
    promoted = promote(raw, src)
    kept, filtered = apply_population_policy(promoted, src, known)
    rec.rows_filtered = raw.num_rows - kept.num_rows

    watermark = pc.max(kept["event_ts"]).as_py() if kept.num_rows else None
    n = kept.num_rows
    prov = pa.table(
        {
            "_source_table": pa.array([fetched.source_table] * n, pa.string()),
            "_is_intraday": pa.array([intraday] * n, pa.bool_()),
            "_source_watermark": pa.array([watermark] * n, pa.timestamp("us", tz="UTC")),
            "_ingestion_run_id": pa.array([run_id] * n, pa.string()),
            "_load_ts": pa.array([load_ts] * n, pa.timestamp("us", tz="UTC")),
        },
        schema=PROVENANCE,
    )
    rows = _hstack(kept, prov)
    schema = rows.schema
    rec.schema_hash = schema_hash(schema)
    rec.source_watermark = watermark.isoformat() if watermark else None
    rec.notes = json.dumps(
        {
            "source_table": fetched.source_table,
            "is_intraday": intraday,
            "bytes_processed": fetched.bytes_processed,
            "job_id": fetched.job_id,
            "filtered_by_population": filtered,
            "known_users": per_source,
        },
        ensure_ascii=False,
    )

    table = ensure_table(catalog, namespace, src.table, schema, partition_by=["event_date"])
    if rows.num_rows and partition_loaded:
        table.overwrite(rows, overwrite_filter=part)
    elif rows.num_rows:
        table.append(rows)
    elif partition_loaded:
        table.delete(part)  # a reload that keeps nothing still replaces the partition
    rec.rows_written = rows.num_rows
    return rec


def _hstack(a: pa.Table, b: pa.Table) -> pa.Table:
    out = a
    for f in b.schema:
        out = out.append_column(f, b[f.name])
    return out
