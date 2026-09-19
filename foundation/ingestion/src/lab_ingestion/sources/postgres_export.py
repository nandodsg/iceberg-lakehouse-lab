"""Read-only export views of the source application's database -> bronze.

One execution = one **full snapshot** of every configured view. The
tables are small, and a hard delete leaves no tombstone in the source,
so only a complete snapshot reconciles it: a row present in the previous
snapshot and absent from this one was physically deleted. The snapshot
id (`snapshot_ts`, UTC, compact ISO) is the load partition, shared by
all the views of one run; reloading a snapshot id replaces it.

The view is read through the application's ODCS contract, one schema
object per view:

- the column list is the contract's, never `select *`;
- before reading, the view's actual columns and types (from
  `information_schema`) are compared with the contract — any difference
  rejects the load of that view, recorded in the manifest. The contract
  is the agreement; bronze does not adapt to drift;
- rows are validated like every other source (required / type / enum);
  the watermark is the maximum of the configured column (the
  application's `updated_at`, a trigger-maintained watermark).

The database role this runs as is expected to see the export schema and
nothing else; `probe()` reports what it can actually reach.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pyarrow as pa
from pyiceberg.catalog import Catalog
from pyiceberg.expressions import EqualTo

from ..catalog import ensure_table
from ..config import PostgresExportSource
from ..contracts import Contract, Field
from ..manifest import RunRecord, append_rejected, schema_hash

PROVENANCE = pa.schema(
    [
        pa.field("snapshot_ts", pa.string(), nullable=False),  # partition: YYYYMMDDTHHMMSSZ
        pa.field("_source_table", pa.string(), nullable=False),  # schema.view
        pa.field("_source_watermark", pa.timestamp("us", tz="UTC")),
        pa.field("_ingestion_run_id", pa.string(), nullable=False),
        pa.field("_load_ts", pa.timestamp("us", tz="UTC"), nullable=False),
    ]
)

_SNAPSHOT = re.compile(r"^\d{8}T\d{6}Z$")


def new_snapshot_ts(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")


def normalize_snapshot_ts(value: str) -> str:
    v = value.strip()
    if not _SNAPSHOT.match(v):
        raise ValueError(f"not a snapshot id: {value!r} (expected YYYYMMDDTHHMMSSZ)")
    datetime.strptime(v, "%Y%m%dT%H%M%SZ")  # validates
    return v


# ---- DSN --------------------------------------------------------------


def resolve_dsn(src: PostgresExportSource, config_dir: Path) -> str:
    """The environment variable wins; otherwise `<config dir>/.env`
    (KEY=value lines, `#` comments, optional quotes). Never the config."""
    v = os.environ.get(src.dsn_env)
    if v:
        return v
    env_file = (config_dir / ".env").resolve()
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():  # -sig: tolerate a BOM
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, val = line.partition("=")
            if k.strip() == src.dsn_env:
                val = val.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                    val = val[1:-1]
                if val:
                    return val
    raise RuntimeError(
        f"no DSN: set {src.dsn_env} in the environment or as `{src.dsn_env}=...` in {env_file}"
    )


# ---- fetch ------------------------------------------------------------


@dataclass
class Fetched:
    rows: list[dict[str, Any]]
    columns: list[tuple[str, str]]  # the view's actual (name, data_type), in position order
    source_table: str  # schema.view


Fetch = Callable[[str, list[str]], Fetched]  # (view, contract columns) -> rows


class SchemaMismatch(Exception):
    """The view does not have exactly the contract's columns and types.
    Nothing is written to bronze; `record` is the manifest row describing
    the rejection (rows all 0, the problems in `notes`) — §14's
    'contract validation results'."""

    def __init__(self, view: str, problems: list[str], record: "RunRecord"):
        super().__init__(f"{view}: {'; '.join(problems)}")
        self.view = view
        self.problems = problems
        self.record = record


# Contract physicalType -> acceptable information_schema data_type values.
PHYSICAL_TO_PG: dict[str, set[str]] = {
    "uuid": {"uuid"},
    "timestamp": {"timestamp with time zone", "timestamp without time zone"},
    "timestamptz": {"timestamp with time zone"},
    "date": {"date"},
    "varchar": {"character varying", "text"},
    "text": {"text", "character varying"},
    "boolean": {"boolean"},
    "integer": {"integer", "smallint", "bigint"},
    "bigint": {"bigint"},
    "numeric": {"numeric", "double precision", "real"},
    "jsonb": {"jsonb", "json"},
    "json": {"json", "jsonb"},
}


def schema_problems(fields: list[Field], actual: list[tuple[str, str]]) -> list[str]:
    """Differences between the contract's columns and the view's: missing,
    extra, or of a type the contract's physical type does not admit."""
    want = {f.name: f for f in fields}
    have = dict(actual)
    problems = []
    for name in want:
        if name not in have:
            problems.append(f"missing column {name}")
    for name in have:
        if name not in want:
            problems.append(f"extra column {name} (not in contract)")
    for name, f in want.items():
        if name not in have or not f.physical_type:
            continue
        ok = PHYSICAL_TO_PG.get(f.physical_type.lower())
        if ok is not None and have[name] not in ok:
            problems.append(f"{name}: contract {f.physical_type}, view {have[name]}")
    return problems


def open_connection(dsn: str):
    """psycopg connection, autocommit, read-only, one statement at a time."""
    import psycopg

    conn = psycopg.connect(dsn, autocommit=True, application_name="lab-ingest")
    conn.read_only = True
    return conn


def fetch_view(conn, schema_name: str, view: str, columns: list[str]) -> Fetched:
    """The view's actual columns (information_schema) and its rows, read
    by the contract's column list. UUIDs come back as strings."""
    from psycopg.rows import dict_row

    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "select column_name, data_type from information_schema.columns "
            "where table_schema = %s and table_name = %s order by ordinal_position",
            (schema_name, view),
        )
        actual = [(r["column_name"], r["data_type"]) for r in cur.fetchall()]
        rows: list[dict[str, Any]] = []
        if set(columns) <= {c for c, _ in actual}:  # else the schema check will reject it
            cols = ", ".join(_ident(c) for c in columns)
            cur.execute(f"select {cols} from {_ident(schema_name)}.{_ident(view)}")
            rows = [{k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in r.items()} for r in cur.fetchall()]
    return Fetched(rows=rows, columns=actual, source_table=f"{schema_name}.{view}")


def _ident(name: str) -> str:
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        raise ValueError(f"not a plain identifier: {name!r}")
    return f'"{name}"'


# ---- load -------------------------------------------------------------


def load_view(
    catalog: Catalog,
    namespace: str,
    src: PostgresExportSource,
    view: str,
    run_id: str,
    snapshot_ts: str,
    fetch: Fetch,
) -> RunRecord:
    """One view -> its bronze table, under the given snapshot id. Raises
    SchemaMismatch (nothing written to bronze) when the view drifted from
    the contract; the caller records that in the manifest."""
    table_name = src.tables.get(view)
    if not table_name:
        raise ValueError(f"view {view!r} has no bronze table in the configuration (tables: {list(src.tables)})")
    contract = Contract.load(src.contract, view)
    schema = pa.unify_schemas([contract.arrow_schema(), PROVENANCE])
    load_ts = datetime.now(timezone.utc)
    rec = RunRecord(
        run_id=run_id,
        source=src.kind,
        table_name=table_name,
        partition=snapshot_ts,
        contract_id=contract.id,
        contract_version=contract.version,
        schema_hash=schema_hash(schema),
    )

    fetched = fetch(view, [f.name for f in contract.fields])
    problems = schema_problems(contract.fields, fetched.columns)
    if problems:
        rec.notes = json.dumps({"view": fetched.source_table, "schema_check": "rejected", "problems": problems})
        rec.contract_checks = contract.quality_records()
        raise SchemaMismatch(fetched.source_table, problems, rec)

    good: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for i, raw in enumerate(fetched.rows, start=1):
        rec.rows_read += 1
        row, reason = contract.validate_row(raw)
        if row is None:
            rejected.append(
                {
                    "_ingestion_run_id": run_id,
                    "_source_file": fetched.source_table,
                    "_line_no": i,
                    "reason": reason or "invalid",
                    "raw": json.dumps(raw, default=str, ensure_ascii=False)[:4000],
                }
            )
            continue
        good.append(row)

    has_wm = any(f.name == src.watermark_column for f in contract.fields)
    watermark = max((r[src.watermark_column] for r in good if r.get(src.watermark_column)), default=None) if has_wm else None
    for r in good:
        r["snapshot_ts"] = snapshot_ts
        r["_source_table"] = fetched.source_table
        r["_source_watermark"] = watermark
        r["_ingestion_run_id"] = run_id
        r["_load_ts"] = load_ts

    rec.rows_rejected = len(rejected)
    rec.source_watermark = watermark.isoformat() if watermark else None
    rec.contract_checks = contract.quality_records()
    rec.notes = json.dumps(
        {"view": fetched.source_table, "schema_check": "ok", "columns": len(fetched.columns), "watermark_column": src.watermark_column if has_wm else None}
    )

    table = ensure_table(catalog, namespace, table_name, schema, partition_by=["snapshot_ts"])
    part = EqualTo("snapshot_ts", snapshot_ts)
    if good:
        arrow = pa.Table.from_pylist(good, schema=schema)
        if table.current_snapshot() is None:
            table.append(arrow)
        else:
            table.overwrite(arrow, overwrite_filter=part)  # idempotent per snapshot id
    elif table.current_snapshot() is not None:
        table.delete(part)  # an empty view still replaces the snapshot's partition
    rec.rows_written = len(good)
    append_rejected(catalog, namespace, table_name, rejected)
    return rec


# ---- probe ------------------------------------------------------------


def probe(conn, schema_name: str) -> dict[str, Any]:
    """What this connection's role can actually reach: its identity and
    settings, the relations it may SELECT from, and — for every table
    outside the export schema — whether a SELECT is denied (a real
    attempt, not only the privilege catalog)."""
    import psycopg
    from psycopg.rows import dict_row

    out: dict[str, Any] = {}
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "select current_user as role, current_setting('search_path') as search_path, "
            "current_setting('statement_timeout') as statement_timeout, version() as version"
        )
        out.update(cur.fetchone())
        cur.execute(
            "select table_schema, table_name, privilege_type from information_schema.table_privileges "
            "where grantee = current_user order by 1, 2, 3"
        )
        grants: dict[str, list[str]] = {}
        for r in cur.fetchall():
            grants.setdefault(f"{r['table_schema']}.{r['table_name']}", []).append(r["privilege_type"])
        out["grants"] = grants
        cur.execute(
            "select schemaname, tablename from pg_catalog.pg_tables "
            "where schemaname not in ('pg_catalog', 'information_schema', %s) order by 1, 2",
            (schema_name,),
        )
        outside = [f"{r['schemaname']}.{r['tablename']}" for r in cur.fetchall()]
        denied, readable = [], []
        for rel in outside:
            s, t = rel.split(".", 1)
            try:
                cur.execute(f"select 1 from {_ident(s)}.{_ident(t)} limit 1")
                cur.fetchall()
                readable.append(rel)
            except psycopg.errors.InsufficientPrivilege:
                denied.append(rel)
        out["outside_export_schema"] = {"tables": len(outside), "select_denied": len(denied), "select_allowed": readable}
    return out
