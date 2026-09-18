"""End-to-end on a synthetic batch: contract validation, rejection,
bronze write, partition overwrite (idempotence), manifest, checks."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow.compute as pc
import pytest

from lab_ingestion.catalog import open_catalog
from lab_ingestion.config import AbmJsonlSource, CatalogConfig
from lab_ingestion.manifest import MANIFEST_TABLE, append_manifest, new_run_id
from lab_ingestion.sources.abm_jsonl import load_file

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "abm-behavioral-events.contract.yaml"


def _row(run_id: str, agent: str, session: str, i: int, action: str, stage: str, done: bool) -> dict:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return {
        "experiment_id": "synthetic-v0",
        "run_id": run_id,
        "agent_id": agent,
        "agent_parameters": {"goal_seeking": 0.5, "exploration": 0.5},
        "condition": "a",
        "session_id": session,
        "timestamp": (t0 + timedelta(seconds=3 * i)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "screen": "/start",
        "element": None if action.startswith("abandon") else "Button",
        "action": action,
        "decision_signals": {"attention": 1.0},
        "elapsed_time": 3 * i,
        "journey_stage": stage,
        "journey_completed": done,
    }


def _write_batch(path: Path, run_id: str, agents: int, terminal: bool = True, garbage: bool = False) -> None:
    lines = []
    for a in range(agents):
        agent, session = f"{run_id}-agent-{a}", str(uuid.uuid4())
        lines.append(_row(run_id, agent, session, 0, "click", "none", False))
        lines.append(_row(run_id, agent, session, 1, "type", "company", False))
        if terminal:
            lines.append(_row(run_id, agent, session, 2, "abandon_idle", "company", False))
    if garbage:
        bad = _row(run_id, "x", str(uuid.uuid4()), 9, "teleport", "none", False)  # not in enum
        lines.append(bad)
        missing = _row(run_id, "y", str(uuid.uuid4()), 9, "click", "none", False)
        del missing["screen"]  # required
        lines.append(missing)
    path.write_text("\n".join(json.dumps(r) for r in lines) + "\n{not json\n", encoding="utf-8")


@pytest.fixture
def catalog(tmp_path: Path):
    cfg = CatalogConfig(type="sql", warehouse=str(tmp_path / "wh"), uri=f"sqlite:///{tmp_path / 'wh' / 'c.db'}")
    return open_catalog(cfg), cfg.namespace


def test_load_validate_overwrite_manifest(tmp_path: Path, catalog):
    cat, ns = catalog
    src = AbmJsonlSource(kind="abm_jsonl", contract=CONTRACT)
    f = tmp_path / "batch-a.jsonl"
    _write_batch(f, "batch-a", agents=3, garbage=True)

    rec = load_file(cat, ns, src, f, new_run_id())
    assert rec.rows_read == 12  # 9 good + 2 invalid + 1 non-JSON
    assert rec.rows_written == 9
    assert rec.rows_rejected == 3
    reasons = {r["reason"].split(":")[0] for r in cat.load_table((ns, "abm_decision_steps__rejected")).scan().to_arrow().to_pylist()}
    assert reasons == {"action", "missing required field screen", "invalid JSON"}
    executed = {c["implementation"]: c["result"] for c in rec.contract_checks if c["executed"]}
    assert executed["terminal_row_per_agent"]["passed"] is True
    assert executed["one_session_per_agent"]["passed"] is True
    assert sum(1 for c in rec.contract_checks if not c["executed"]) == 1  # the text rule is recorded, not run

    # Reloading the same file replaces its partition — no duplicates.
    rec2 = load_file(cat, ns, src, f, new_run_id())
    table = cat.load_table((ns, "abm_decision_steps"))
    assert table.scan().to_arrow().num_rows == 9
    assert rec2.rows_written == 9

    # A second batch lands in its own partition; the first is untouched.
    g = tmp_path / "batch-b.jsonl"
    _write_batch(g, "batch-b", agents=2, terminal=False)
    rec3 = load_file(cat, ns, src, g, new_run_id())
    arrow = cat.load_table((ns, "abm_decision_steps")).scan().to_arrow()
    assert arrow.num_rows == 13
    assert set(pc.unique(arrow["_source_batch"]).to_pylist()) == {"batch-a", "batch-b"}
    terminal = {c["implementation"]: c["result"] for c in rec3.contract_checks if c["executed"]}["terminal_row_per_agent"]
    assert terminal["passed"] is False and terminal["non_terminal"] == 2

    append_manifest(cat, ns, [rec, rec2, rec3])
    manifest = cat.load_table((ns, MANIFEST_TABLE)).scan().to_arrow().to_pylist()
    assert [m["partition"] for m in manifest] == ["batch-a", "batch-a", "batch-b"]
    assert manifest[0]["contract_id"] == "abm-behavioral-events"
    assert manifest[0]["contract_version"] == "1.0.0"
    assert json.loads(manifest[2]["contract_checks"])[0]["result"]["non_terminal"] == 2
