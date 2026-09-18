"""`lab-ingest` — the batch extractor's command line.

Every command takes `--config <yaml>` (the deployment's real
configuration, kept outside this repository) and is idempotent per load
partition: re-running replaces, never duplicates.
"""

from __future__ import annotations

from pathlib import Path

import typer

from .catalog import open_catalog
from .config import AbmJsonlSource, Config
from .manifest import MANIFEST_TABLE, append_manifest, new_run_id

app = typer.Typer(no_args_is_help=True, add_completion=False)


def _load(config: Path) -> Config:
    return Config.load(config)


def _source(cfg: Config, name: str, kind: type):
    src = cfg.sources.get(name)
    if src is None:
        raise typer.BadParameter(f"no source named {name!r} in config (have: {', '.join(cfg.sources)})")
    if not isinstance(src, kind):
        raise typer.BadParameter(f"source {name!r} is {src.kind}, expected {kind.__name__}")
    return src


@app.command("abm-jsonl")
def abm_jsonl(
    paths: list[Path] = typer.Argument(..., help="JSONL batch files (one file = one load partition)"),
    config: Path = typer.Option(..., "--config", "-c", exists=True, dir_okay=False),
    source: str = typer.Option("abm", "--source", "-s", help="source name in the config"),
):
    """Load ABM harness batches into bronze, validating each row against
    the ABM behavioral-events contract."""
    from .sources.abm_jsonl import load_file

    cfg = _load(config)
    src = _source(cfg, source, AbmJsonlSource)
    catalog = open_catalog(cfg.catalog)
    run_id = new_run_id()
    records = []
    for p in paths:
        rec = load_file(catalog, cfg.catalog.namespace, src, p, run_id)
        records.append(rec)
        checks = [c for c in rec.contract_checks if c["executed"]]
        failed = [c["implementation"] for c in checks if c["result"] and not c["result"].get("passed", True)]
        typer.echo(
            f"{p.name}: read {rec.rows_read} written {rec.rows_written} "
            f"rejected {rec.rows_rejected} watermark {rec.source_watermark} "
            f"checks {len(checks)} failed {failed or 'none'}"
        )
    append_manifest(catalog, cfg.catalog.namespace, records)
    typer.echo(f"run {run_id}: {len(records)} partition(s) -> {cfg.catalog.namespace}.{src.table}")


@app.command("runs")
def runs(
    config: Path = typer.Option(..., "--config", "-c", exists=True, dir_okay=False),
    limit: int = typer.Option(20, "--limit", "-n"),
):
    """Show the most recent manifest rows."""
    cfg = _load(config)
    catalog = open_catalog(cfg.catalog)
    table = catalog.load_table((cfg.catalog.namespace, MANIFEST_TABLE))
    df = table.scan().to_arrow().to_pylist()
    df.sort(key=lambda r: r["load_ts"], reverse=True)
    for r in df[:limit]:
        typer.echo(
            f"{r['load_ts']:%Y-%m-%d %H:%M:%S} {r['run_id']} {r['source']:<14} "
            f"{r['table_name']:<20} {r['partition']:<28} read={r['rows_read']} "
            f"written={r['rows_written']} rejected={r['rows_rejected']} filtered={r['rows_filtered']}"
        )


@app.command("tables")
def tables(config: Path = typer.Option(..., "--config", "-c", exists=True, dir_okay=False)):
    """List bronze tables with their current row counts."""
    cfg = _load(config)
    catalog = open_catalog(cfg.catalog)
    for ident in sorted(catalog.list_tables(cfg.catalog.namespace)):
        t = catalog.load_table(ident)
        n = sum(f.file.record_count for f in t.scan().plan_files())
        typer.echo(f"{'.'.join(ident):<40} rows={n} snapshots={len(t.history())}")
