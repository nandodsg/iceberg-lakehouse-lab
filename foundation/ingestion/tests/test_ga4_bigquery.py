"""GA4 export -> bronze on a synthetic, export-shaped Arrow table:
promotion of user properties, the population policy, intraday -> daily
replacement (and the refusal of the reverse), manifest record."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pytest

from lab_ingestion.catalog import ensure_table, open_catalog
from lab_ingestion.config import CatalogConfig, Ga4BigQuerySource, KnownUsersRef
from lab_ingestion.manifest import new_run_id
from lab_ingestion.sources.ga4_bigquery import (
    Fetched,
    IntradayOverDaily,
    export_table,
    known_user_ids,
    load_day,
    normalize_day,
)

VALUE = pa.struct(
    [("string_value", pa.string()), ("int_value", pa.int64()), ("float_value", pa.float64()), ("double_value", pa.float64())]
)
UP_VALUE = pa.struct(VALUE.fields + [pa.field("set_timestamp_micros", pa.int64())])
PARAMS = pa.list_(pa.field("item", pa.struct([("key", pa.string()), ("value", VALUE)]), nullable=False))
USER_PROPS = pa.list_(pa.field("item", pa.struct([("key", pa.string()), ("value", UP_VALUE)]), nullable=False))
DEVICE = pa.struct([("category", pa.string()), ("web_info", pa.struct([("browser", pa.string())]))])

EXPORT_SCHEMA = pa.schema(
    [
        ("event_date", pa.string()),
        ("event_timestamp", pa.int64()),
        ("event_name", pa.string()),
        ("event_params", PARAMS),
        ("user_id", pa.string()),
        ("user_pseudo_id", pa.string()),
        ("user_properties", USER_PROPS),
        ("device", DEVICE),
        ("platform", pa.string()),
    ]
)

T0 = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1_000_000)


def _sv(s):
    return {"string_value": s, "int_value": None, "float_value": None, "double_value": None}


def _event(day: str, i: int, name: str, user_id: str | None, props: dict[str, str] | None) -> dict:
    return {
        "event_date": day,
        "event_timestamp": T0 + i * 1_000_000,
        "event_name": name,
        "event_params": [{"key": "page_location", "value": _sv("/start")}],
        "user_id": user_id,
        "user_pseudo_id": uuid.uuid4().hex,
        "user_properties": [{"key": k, "value": {**_sv(v), "set_timestamp_micros": T0}} for k, v in (props or {}).items()],
        "device": {"category": "desktop", "web_info": {"browser": "Chrome"}},
        "platform": "WEB",
    }


KNOWN = str(uuid.uuid4())
UNKNOWN = str(uuid.uuid4())


def _export(day: str, n_extra: int = 0) -> pa.Table:
    rows = [
        _event(day, 0, "login", KNOWN, None),  # no properties, known user -> kept
        _event(day, 1, "page_view", KNOWN, {"population": "abm", "exp_x": "a"}),  # kept
        _event(day, 2, "page_view", str(uuid.uuid4()), {"population": "synthetic"}),  # kept
        _event(day, 3, "page_view", str(uuid.uuid4()), {"population": "real", "exp_x": "b"}),  # filtered
        _event(day, 4, "login", UNKNOWN, None),  # no properties, unknown user -> filtered
        _event(day, 5, "page_view", None, None),  # anonymous -> filtered
    ]
    rows += [_event(day, 10 + i, "page_view", KNOWN, {"population": "abm"}) for i in range(n_extra)]
    return pa.Table.from_pylist(rows, schema=EXPORT_SCHEMA)


def _fetch(tables: dict[str, pa.Table]):
    def fetch(src, day, intraday):
        name = export_table(day, intraday)
        return Fetched(table=tables[name], source_table=f"p.d.{name}", bytes_processed=123, job_id="job")

    return fetch


@pytest.fixture
def catalog(tmp_path: Path):
    cfg = CatalogConfig(type="sql", warehouse=str(tmp_path / "wh"), uri=f"sqlite:///{tmp_path / 'wh' / 'c.db'}")
    cat = open_catalog(cfg)
    # The other bronze source the allow-list is built from.
    abm = ensure_table(cat, cfg.namespace, "abm_decision_steps", pa.schema([("session_id", pa.string())]))
    abm.append(pa.table({"session_id": [KNOWN, KNOWN]}))
    return cat, cfg.namespace


SRC = Ga4BigQuerySource(
    kind="ga4_bigquery", project="p", dataset="d", promoted_user_properties=["population", "exp_x"]
)


def test_normalize_day():
    assert normalize_day("2026-09-16") == normalize_day("20260916") == "20260916"
    with pytest.raises(ValueError):
        normalize_day("2026-13-01")


def test_known_users_from_other_bronze(catalog):
    cat, ns = catalog
    ids, per = known_user_ids(cat, ns, SRC)
    assert ids == {KNOWN}
    assert per == {"abm_decision_steps.session_id": 1}
    missing = SRC.model_copy(update={"known_user_sources": [KnownUsersRef(table="nope", column="x")]})
    assert known_user_ids(cat, ns, missing) == (set(), {"nope.x": 0})


def test_promote_filter_and_manifest(catalog):
    cat, ns = catalog
    rec = load_day(cat, ns, SRC, "2026-01-01", new_run_id(), fetch=_fetch({"events_20260101": _export("20260101")}))
    assert (rec.rows_read, rec.rows_written, rec.rows_filtered, rec.rows_rejected) == (6, 3, 3, 0)
    notes = json.loads(rec.notes)
    assert notes["filtered_by_population"] == {"(null)": 2, "real": 1}
    assert notes["known_users"] == {"abm_decision_steps.session_id": 1}
    assert notes["source_table"] == "p.d.events_20260101" and notes["bytes_processed"] == 123
    assert rec.partition == "20260101" and rec.source_watermark.startswith("2026-01-01T00:00:02")

    t = cat.load_table((ns, "app_events")).scan().to_arrow()
    assert sorted(t["event_name"].to_pylist()) == ["login", "page_view", "page_view"]
    assert set(t["population"].to_pylist()) == {None, "abm", "synthetic"}
    assert t.filter(pc.equal(t["event_name"], "login"))["user_id"][0].as_py() == KNOWN
    assert t["exp_x"].to_pylist().count("a") == 1
    assert t["event_ts"][0].as_py().tzinfo is not None
    up = t.schema.field("user_properties").type  # nested structure kept, not flattened to text
    assert pa.types.is_list(up) and pa.types.is_struct(up.value_type)
    assert t["_is_intraday"].to_pylist() == [False] * 3
    assert {f.name for f in t.schema}.issuperset({"event_params", "device", "_source_table", "_ingestion_run_id"})


def test_intraday_then_daily_replaces_and_reverse_is_refused(catalog):
    cat, ns = catalog
    tables = {"events_intraday_20260102": _export("20260102", n_extra=2), "events_20260102": _export("20260102")}
    fetch = _fetch(tables)
    rec = load_day(cat, ns, SRC, "20260102", new_run_id(), intraday=True, fetch=fetch)
    assert rec.rows_written == 5
    tbl = cat.load_table((ns, "app_events"))
    assert tbl.scan().to_arrow()["_is_intraday"].to_pylist() == [True] * 5

    rec = load_day(cat, ns, SRC, "20260102", new_run_id(), fetch=fetch)  # the daily arrives: replaces
    assert rec.rows_written == 3
    t = cat.load_table((ns, "app_events")).scan().to_arrow()
    assert t.num_rows == 3 and t["_is_intraday"].to_pylist() == [False] * 3

    with pytest.raises(IntradayOverDaily):
        load_day(cat, ns, SRC, "20260102", new_run_id(), intraday=True, fetch=fetch)
    rec = load_day(cat, ns, SRC, "20260102", new_run_id(), intraday=True, force=True, fetch=fetch)
    assert rec.rows_written == 5
    assert cat.load_table((ns, "app_events")).scan().to_arrow().num_rows == 5


def test_reload_is_idempotent_across_days(catalog):
    cat, ns = catalog
    fetch = _fetch({"events_20260103": _export("20260103"), "events_20260104": _export("20260104", n_extra=1)})
    for _ in range(2):
        load_day(cat, ns, SRC, "20260103", new_run_id(), fetch=fetch)
        load_day(cat, ns, SRC, "20260104", new_run_id(), fetch=fetch)
    t = cat.load_table((ns, "app_events")).scan().to_arrow()
    assert sorted(t["event_date"].to_pylist()) == ["20260103"] * 3 + ["20260104"] * 4
