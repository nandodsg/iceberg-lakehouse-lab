"""The two human-facing views of the bronze, on a synthetic table:
DuckDB views over the current metadata, and the anatomy report."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow as pa
import pytest

from lab_ingestion.catalog import ensure_table, open_catalog
from lab_ingestion.config import CatalogConfig
from lab_ingestion.explore import anatomy, duckdb_views


@pytest.fixture
def catalog(tmp_path: Path):
    cfg = CatalogConfig(type="sql", warehouse=str(tmp_path / "wh"), uri=f"sqlite:///{tmp_path / 'wh' / 'c.db'}")
    cat = open_catalog(cfg)
    schema = pa.schema([("day", pa.string()), ("n", pa.int64()), ("_ingestion_run_id", pa.string())])
    t = ensure_table(cat, cfg.namespace, "things", schema, partition_by=["day"])
    t.append(pa.table({"day": ["d1", "d1"], "n": [1, 2], "_ingestion_run_id": ["run-a", "run-a"]}))
    t.append(pa.table({"day": ["d2"], "n": [3], "_ingestion_run_id": ["run-b"]}))
    return cat, cfg.namespace, tmp_path


def test_duckdb_views_follow_current_metadata(catalog):
    cat, ns, tmp = catalog
    db = tmp / "lab.duckdb"
    views = duckdb_views(cat, ns, db)
    assert [v for v, _ in views] == ["things"]
    assert views[0][1] == cat.load_table((ns, "things")).metadata_location
    con = duckdb.connect(str(db), read_only=True)
    assert con.sql("select sum(n) from things").fetchone() == (6,)
    # the anatomy as tables: snapshot history and the current snapshot's files
    assert con.sql("select operation from things__snapshots").fetchall() == [("append",), ("append",)]
    assert con.sql("select record_count from things__files order by file_path").fetchall() == [(2,), (1,)]
    con.close()

    # a new load -> new metadata file; the view is refreshed only by re-running
    cat.load_table((ns, "things")).append(pa.table({"day": ["d3"], "n": [4], "_ingestion_run_id": ["run-c"]}))
    con = duckdb.connect(str(db), read_only=True)
    assert con.sql("select sum(n) from things").fetchone() == (6,)
    con.close()
    duckdb_views(cat, ns, db)
    con = duckdb.connect(str(db), read_only=True)
    assert con.sql("select sum(n) from things").fetchone() == (10,)
    con.close()


def test_anatomy_walks_the_chain(catalog):
    cat, ns, _ = catalog
    text = "\n".join(anatomy(cat, ns, "things"))
    for marker in ("1. CATALOG ROW", "2. METADATA FILE", "3. CURRENT SNAPSHOT", "4. MANIFEST LIST", "5. MANIFESTS", "6. DATA FILES"):
        assert marker in text
    assert "partitioned by: day (identity)" in text
    assert "2 snapshot(s) in history" in text
    assert "operation=append" in text
    assert "[day=d1] 2 rows" in text and "load run-a" in text
    assert "[day=d2] 1 rows" in text and "load run-b" in text
    assert "total: 3 rows in 2 data file(s)" in text
