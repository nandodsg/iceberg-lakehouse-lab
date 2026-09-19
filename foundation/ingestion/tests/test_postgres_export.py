"""Export views -> bronze on a synthetic multi-object contract and an
in-memory fetch: per-object contract loading, the schema check against
the view (rejection recorded, nothing written), row validation, the
snapshot partition and its idempotent reload, DSN resolution."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from lab_ingestion.catalog import open_catalog
from lab_ingestion.config import CatalogConfig, PostgresExportSource
from lab_ingestion.contracts import Contract
from lab_ingestion.manifest import new_run_id
from lab_ingestion.sources.postgres_export import (
    Fetched,
    SchemaMismatch,
    load_view,
    new_snapshot_ts,
    normalize_snapshot_ts,
    resolve_dsn,
    schema_problems,
)

CONTRACT = """
apiVersion: v3.0.0
kind: DataContract
id: synthetic-entities-export
version: 0.1.0
status: active
schema:
  - name: owners
    logicalType: object
    physicalType: view
    properties:
      - {name: id, logicalType: string, physicalType: uuid, required: true, primaryKey: true}
      - {name: created_at, logicalType: date, physicalType: timestamp, required: true}
      - {name: updated_at, logicalType: date, physicalType: timestamp, required: true}
  - name: widgets
    logicalType: object
    physicalType: view
    properties:
      - {name: id, logicalType: string, physicalType: uuid, required: true, primaryKey: true}
      - {name: owner_id, logicalType: string, physicalType: uuid, required: false}
      - name: kind
        logicalType: string
        physicalType: varchar
        required: true
        logicalTypeOptions: {enum: [round, square]}
      - {name: active, logicalType: boolean, physicalType: boolean, required: true}
      - {name: created_at, logicalType: date, physicalType: timestamp, required: true}
      - {name: updated_at, logicalType: date, physicalType: timestamp, required: true}
      - {name: deleted_at, logicalType: date, physicalType: timestamp, required: false}
quality:
  - description: hard delete leaves no tombstone; keep periodic snapshots
    dimension: completeness
    status: by design
"""

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
TS = "timestamp with time zone"
OWNERS_COLS = [("id", "uuid"), ("created_at", TS), ("updated_at", TS)]
WIDGETS_COLS = [
    ("id", "uuid"), ("owner_id", "uuid"), ("kind", "character varying"), ("active", "boolean"),
    ("created_at", TS), ("updated_at", TS), ("deleted_at", TS),
]
OWNER = str(uuid.uuid4())


def _owners(n: int) -> list[dict]:
    return [{"id": OWNER if i == 0 else str(uuid.uuid4()), "created_at": T0, "updated_at": T0 + timedelta(hours=i)} for i in range(n)]


def _widgets(n: int, bad: bool = False) -> list[dict]:
    rows = [
        {
            "id": str(uuid.uuid4()), "owner_id": OWNER if i % 2 == 0 else None, "kind": "round" if i % 2 else "square",
            "active": True, "created_at": T0, "updated_at": T0 + timedelta(days=i), "deleted_at": None if i else T0 + timedelta(days=9),
        }
        for i in range(n)
    ]
    if bad:
        rows.append({**rows[0], "id": str(uuid.uuid4()), "kind": "hexagon"})  # not in enum
    return rows


def _fetch(views: dict[str, tuple[list[dict], list[tuple[str, str]]]]):
    def fetch(view, columns):
        rows, cols = views[view]
        return Fetched(rows=rows, columns=cols, source_table=f"export.{view}")

    return fetch


@pytest.fixture
def contract_path(tmp_path: Path) -> Path:
    p = tmp_path / "synthetic.contract.yaml"
    p.write_text(CONTRACT, encoding="utf-8")
    return p


@pytest.fixture
def src(contract_path: Path) -> PostgresExportSource:
    return PostgresExportSource(
        kind="postgres_export", contract=contract_path,
        tables={"owners": "app_entities_owners", "widgets": "app_entities_widgets"},
    )


@pytest.fixture
def catalog(tmp_path: Path):
    cfg = CatalogConfig(type="sql", warehouse=str(tmp_path / "wh"), uri=f"sqlite:///{tmp_path / 'wh' / 'c.db'}")
    return open_catalog(cfg), cfg.namespace


def test_multi_object_contract(contract_path: Path):
    assert Contract.object_names(contract_path) == ["owners", "widgets"]
    with pytest.raises(ValueError, match="2 schema objects"):
        Contract.load(contract_path)
    with pytest.raises(ValueError, match="no schema object named"):
        Contract.load(contract_path, "gadgets")
    c = Contract.load(contract_path, "widgets")
    assert c.object_name == "widgets" and [f.name for f in c.fields][:3] == ["id", "owner_id", "kind"]
    assert len(c.quality) == 1


def test_snapshot_ids():
    assert normalize_snapshot_ts(" 20260101T000000Z ") == "20260101T000000Z"
    assert normalize_snapshot_ts(new_snapshot_ts(T0)) == "20260101T000000Z"
    for bad in ("2026-01-01", "20261301T000000Z", "20260101T000000"):
        with pytest.raises(ValueError):
            normalize_snapshot_ts(bad)


def test_schema_problems(contract_path: Path):
    contract_fields = Contract.load(contract_path, "widgets").fields
    assert schema_problems(contract_fields, WIDGETS_COLS) == []
    assert schema_problems(contract_fields, WIDGETS_COLS[:-1]) == ["missing column deleted_at"]
    assert schema_problems(contract_fields, WIDGETS_COLS + [("name", "text")]) == ["extra column name (not in contract)"]
    drift = [(n, "text" if n == "active" else t) for n, t in WIDGETS_COLS]
    assert schema_problems(contract_fields, drift) == ["active: contract boolean, view text"]
    assert schema_problems(contract_fields, [(n, "text" if t == "character varying" else t) for n, t in WIDGETS_COLS]) == []  # varchar admits text


def test_snapshot_load_and_manifest(catalog, src):
    cat, ns = catalog
    fetch = _fetch({"owners": (_owners(2), OWNERS_COLS), "widgets": (_widgets(3, bad=True), WIDGETS_COLS)})
    run, snap = new_run_id(), "20260102T030405Z"
    o = load_view(cat, ns, src, "owners", run, snap, fetch)
    w = load_view(cat, ns, src, "widgets", run, snap, fetch)
    assert (o.rows_read, o.rows_written, o.rows_rejected) == (2, 2, 0)
    assert (w.rows_read, w.rows_written, w.rows_rejected) == (4, 3, 1)
    assert o.partition == w.partition == snap and o.table_name == "app_entities_owners"
    assert o.source_watermark.startswith("2026-01-01T01:00") and w.source_watermark.startswith("2026-01-03T00:00")
    assert o.contract_id == "synthetic-entities-export" and o.contract_version == "0.1.0"
    assert json.loads(w.notes) == {"view": "export.widgets", "schema_check": "ok", "columns": 7, "watermark_column": "updated_at"}
    assert [c["dimension"] for c in w.contract_checks] == ["completeness"] and not w.contract_checks[0]["executed"]

    t = cat.load_table((ns, "app_entities_widgets")).scan().to_arrow()
    assert t.num_rows == 3 and set(t["snapshot_ts"].to_pylist()) == {snap}
    assert t.schema.field("deleted_at").type == t.schema.field("_source_watermark").type  # timestamptz from the contract
    assert t["deleted_at"].to_pylist().count(None) == 2 and t["_source_table"][0].as_py() == "export.widgets"
    assert t["owner_id"].to_pylist().count(OWNER) == 2
    rej = cat.load_table((ns, "app_entities_widgets__rejected")).scan().to_arrow().to_pylist()
    assert len(rej) == 1 and rej[0]["reason"] == "kind: 'hexagon' not in enum" and rej[0]["_source_file"] == "export.widgets"


def test_schema_mismatch_rejects_the_view(catalog, src):
    cat, ns = catalog
    fetch = _fetch({"widgets": (_widgets(2), WIDGETS_COLS + [("secret", "text")])})
    with pytest.raises(SchemaMismatch) as e:
        load_view(cat, ns, src, "widgets", new_run_id(), new_snapshot_ts(), fetch)
    assert e.value.problems == ["extra column secret (not in contract)"]
    rec = e.value.record
    assert (rec.rows_read, rec.rows_written, rec.table_name) == (0, 0, "app_entities_widgets")
    assert json.loads(rec.notes)["schema_check"] == "rejected"
    assert (ns, "app_entities_widgets") not in cat.list_tables(ns)  # nothing written, table not even created


def test_reload_replaces_snapshot_and_keeps_others(catalog, src):
    cat, ns = catalog
    fetch = _fetch({"owners": (_owners(3), OWNERS_COLS)})
    load_view(cat, ns, src, "owners", new_run_id(), "20260101T000000Z", fetch)
    load_view(cat, ns, src, "owners", new_run_id(), "20260101T000000Z", fetch)  # same snapshot id: replaced
    load_view(cat, ns, src, "owners", new_run_id(), "20260102T000000Z", fetch)  # new snapshot: added
    t = cat.load_table((ns, "app_entities_owners")).scan().to_arrow()
    assert sorted(t["snapshot_ts"].to_pylist()) == ["20260101T000000Z"] * 3 + ["20260102T000000Z"] * 3
    # An empty view still replaces its snapshot partition.
    rec = load_view(cat, ns, src, "owners", new_run_id(), "20260102T000000Z", _fetch({"owners": ([], OWNERS_COLS)}))
    assert rec.rows_written == 0 and rec.source_watermark is None
    assert cat.load_table((ns, "app_entities_owners")).scan().to_arrow().num_rows == 3


def test_unconfigured_view(catalog, src):
    cat, ns = catalog
    with pytest.raises(ValueError, match="no bronze table"):
        load_view(cat, ns, src, "gadgets", new_run_id(), new_snapshot_ts(), _fetch({}))


def test_resolve_dsn(tmp_path: Path, src, monkeypatch):
    monkeypatch.delenv("LAB_PG_DSN", raising=False)
    with pytest.raises(RuntimeError, match="LAB_PG_DSN"):
        resolve_dsn(src, tmp_path)
    (tmp_path / ".env").write_text("# comment\nOTHER=1\nLAB_PG_DSN='postgresql://u:p@h/db?sslmode=require'\n", encoding="utf-8")
    assert resolve_dsn(src, tmp_path) == "postgresql://u:p@h/db?sslmode=require"
    monkeypatch.setenv("LAB_PG_DSN", "postgresql://env")
    assert resolve_dsn(src, tmp_path) == "postgresql://env"
