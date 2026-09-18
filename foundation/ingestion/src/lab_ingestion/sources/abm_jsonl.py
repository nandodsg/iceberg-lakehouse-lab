"""ABM harness output -> bronze.

One JSONL file = one harness batch = one unit of load. Rows carry their
own `run_id`, but the *file* is what gets replaced on reload (a batch
re-run writes a new file), so the load partition is the file stem,
recorded as `_source_batch`, together with `experiment_id`.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
from pyiceberg.catalog import Catalog
from pyiceberg.expressions import And, EqualTo

from ..catalog import ensure_table
from ..config import AbmJsonlSource
from ..contracts import CHECKS, Contract, check
from ..manifest import RunRecord, append_rejected, schema_hash

PROVENANCE = pa.schema(
    [
        pa.field("_source_batch", pa.string(), nullable=False),
        pa.field("_source_file", pa.string(), nullable=False),
        pa.field("_source_watermark", pa.timestamp("us", tz="UTC")),
        pa.field("_ingestion_run_id", pa.string(), nullable=False),
        pa.field("_load_ts", pa.timestamp("us", tz="UTC"), nullable=False),
    ]
)


@check("terminal_row_per_agent")
def terminal_row_per_agent(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Every (run_id, agent_id) ends — by timestamp — on a terminal row:
    journey_completed = true or an abandon_* action."""
    last: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        k = (r["run_id"], r["agent_id"])
        if k not in last or r["timestamp"] >= last[k]["timestamp"]:
            last[k] = r
    bad = [
        {"run_id": k[0], "agent_id": k[1], "action": r["action"], "journey_stage": r["journey_stage"]}
        for k, r in last.items()
        if not (r["journey_completed"] or str(r["action"]).startswith("abandon"))
    ]
    return {"agents": len(last), "non_terminal": len(bad), "passed": not bad, "examples": bad[:5]}


@check("one_session_per_agent")
def one_session_per_agent(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """(run_id, agent_id) <-> session_id is one-to-one within a batch."""
    by_agent: dict[tuple[str, str], set[str]] = {}
    by_session: dict[str, set[tuple[str, str]]] = {}
    for r in rows:
        k = (r["run_id"], r["agent_id"])
        by_agent.setdefault(k, set()).add(r["session_id"])
        by_session.setdefault(r["session_id"], set()).add(k)
    multi_session = [k for k, v in by_agent.items() if len(v) > 1]
    shared_session = [s for s, v in by_session.items() if len(v) > 1]
    return {
        "agents": len(by_agent),
        "agents_with_multiple_sessions": len(multi_session),
        "sessions_shared_by_agents": len(shared_session),
        "passed": not multi_session and not shared_session,
    }


def load_file(
    catalog: Catalog,
    namespace: str,
    src: AbmJsonlSource,
    path: Path,
    run_id: str,
) -> RunRecord:
    contract = Contract.load(src.contract)
    schema = pa.unify_schemas([contract.arrow_schema(), PROVENANCE])
    load_ts = datetime.now(timezone.utc)
    batch = path.stem
    rec = RunRecord(
        run_id=run_id,
        source=src.kind,
        table_name=src.table,
        partition=batch,
        contract_id=contract.id,
        contract_version=contract.version,
        schema_hash=schema_hash(schema),
    )

    good: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            rec.rows_read += 1
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as e:
                rejected.append(_rej(run_id, path, line_no, f"invalid JSON: {e.msg}", line))
                continue
            row, reason = contract.validate_row(raw)
            if row is None:
                rejected.append(_rej(run_id, path, line_no, reason or "invalid", line))
                continue
            good.append(row)

    watermark = max((r["timestamp"] for r in good), default=None)
    for r in good:
        r["_source_batch"] = batch
        r["_source_file"] = path.name
        r["_source_watermark"] = watermark
        r["_ingestion_run_id"] = run_id
        r["_load_ts"] = load_ts

    results = {name: fn(good) for name, fn in CHECKS.items() if _declared(contract, name)}
    rec.contract_checks = contract.quality_records(results)
    rec.rows_rejected = len(rejected)
    rec.source_watermark = watermark.isoformat() if watermark else None

    table = ensure_table(catalog, namespace, src.table, schema, partition_by=["experiment_id", "_source_batch"])
    if good:
        arrow = pa.Table.from_pylist(good, schema=schema)
        by_exp: dict[str, int] = defaultdict(int)
        for r in good:
            by_exp[r["experiment_id"]] += 1
        # Idempotent: replace exactly this file's partitions.
        for exp in by_exp:
            part = arrow.filter(pc.equal(arrow["experiment_id"], exp))
            if table.current_snapshot() is None:
                table.append(part)
            else:
                table.overwrite(
                    part, overwrite_filter=And(EqualTo("experiment_id", exp), EqualTo("_source_batch", batch))
                )
        rec.rows_written = len(good)
    append_rejected(catalog, namespace, src.table, rejected)
    return rec


def _declared(contract: Contract, name: str) -> bool:
    return any(q.type == "custom" and q.implementation == name for q in contract.quality)


def _rej(run_id: str, path: Path, line_no: int, reason: str, raw: str) -> dict[str, Any]:
    return {
        "_ingestion_run_id": run_id,
        "_source_file": path.name,
        "_line_no": line_no,
        "reason": reason,
        "raw": raw[:4000],
    }
