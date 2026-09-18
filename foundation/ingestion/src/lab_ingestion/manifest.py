"""The ingestion manifest — one row per (source, partition) per run,
recording what iceberg-lakehouse-lab.md §14 asks the ingestion layer to
record: row counts, schema validation, load timestamp, source watermark,
rejected records, contract validation results."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import pyarrow as pa
from pyiceberg.catalog import Catalog

from .catalog import ensure_table

MANIFEST_TABLE = "_ingestion_runs"

MANIFEST_SCHEMA = pa.schema(
    [
        pa.field("run_id", pa.string(), nullable=False),
        pa.field("source", pa.string(), nullable=False),
        pa.field("table_name", pa.string(), nullable=False),
        pa.field("partition", pa.string(), nullable=False),
        pa.field("rows_read", pa.int64(), nullable=False),
        pa.field("rows_written", pa.int64(), nullable=False),
        pa.field("rows_rejected", pa.int64(), nullable=False),
        pa.field("rows_filtered", pa.int64(), nullable=False),
        pa.field("source_watermark", pa.string()),
        pa.field("load_ts", pa.timestamp("us", tz="UTC"), nullable=False),
        pa.field("contract_id", pa.string()),
        pa.field("contract_version", pa.string()),
        pa.field("contract_checks", pa.string()),  # JSON list
        pa.field("schema_hash", pa.string()),
        pa.field("notes", pa.string()),
    ]
)

REJECTED_SCHEMA = pa.schema(
    [
        pa.field("_ingestion_run_id", pa.string(), nullable=False),
        pa.field("_source_file", pa.string(), nullable=False),
        pa.field("_line_no", pa.int64(), nullable=False),
        pa.field("reason", pa.string(), nullable=False),
        pa.field("raw", pa.string(), nullable=False),
    ]
)


def new_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]


def schema_hash(schema: pa.Schema) -> str:
    return hashlib.sha256(str(schema).encode()).hexdigest()[:16]


@dataclass
class RunRecord:
    run_id: str
    source: str
    table_name: str
    partition: str
    rows_read: int = 0
    rows_written: int = 0
    rows_rejected: int = 0
    rows_filtered: int = 0
    source_watermark: str | None = None
    load_ts: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    contract_id: str | None = None
    contract_version: str | None = None
    contract_checks: list[dict[str, Any]] = field(default_factory=list)
    schema_hash: str | None = None
    notes: str | None = None

    def to_row(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["contract_checks"] = json.dumps(self.contract_checks, ensure_ascii=False)
        return d


def append_manifest(catalog: Catalog, namespace: str, records: list[RunRecord]) -> None:
    table = ensure_table(catalog, namespace, MANIFEST_TABLE, MANIFEST_SCHEMA)
    table.append(pa.Table.from_pylist([r.to_row() for r in records], schema=MANIFEST_SCHEMA))


def append_rejected(catalog: Catalog, namespace: str, table_name: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    table = ensure_table(catalog, namespace, f"{table_name}__rejected", REJECTED_SCHEMA)
    table.append(pa.Table.from_pylist(rows, schema=REJECTED_SCHEMA))
