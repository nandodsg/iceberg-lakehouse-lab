"""`lab-ingest` — the batch extractor's command line.

Every command takes `--config <yaml>` (the deployment's real
configuration, kept outside this repository) and is idempotent per load
partition: re-running replaces, never duplicates.
"""

from __future__ import annotations

import json
from pathlib import Path

import typer

from .catalog import open_catalog
from .config import AbmJsonlSource, Config, Ga4BigQuerySource
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


def _expand(paths: list[str]) -> list[Path]:
    """Files, directories (all *.jsonl inside, non-recursive) or glob
    patterns — expanded here so the command behaves the same from a
    shell that expands globs (bash) and one that does not (PowerShell)."""
    import glob

    out: list[Path] = []
    for p in paths:
        if any(ch in p for ch in "*?["):
            out.extend(Path(m) for m in sorted(glob.glob(p)))
        elif Path(p).is_dir():
            out.extend(sorted(Path(p).glob("*.jsonl")))
        else:
            out.append(Path(p))
    missing = [str(p) for p in out if not p.is_file()]
    if missing or not out:
        raise typer.BadParameter(f"no such file(s): {missing or paths}")
    return out


@app.command("abm-jsonl")
def abm_jsonl(
    paths: list[str] = typer.Argument(..., help="JSONL batch files, directories or glob patterns (one file = one load partition)"),
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
    for p in _expand(paths):
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


def _days(days: list[str]) -> list[str]:
    """Days as YYYYMMDD / YYYY-MM-DD, or inclusive ranges `A..B`."""
    from datetime import datetime, timedelta

    from .sources.ga4_bigquery import normalize_day

    out: list[str] = []
    for d in days:
        if ".." in d:
            a, b = (normalize_day(x) for x in d.split("..", 1))
            cur, end = datetime.strptime(a, "%Y%m%d"), datetime.strptime(b, "%Y%m%d")
            while cur <= end:
                out.append(cur.strftime("%Y%m%d"))
                cur += timedelta(days=1)
        else:
            out.append(normalize_day(d))
    return out


@app.command("ga4")
def ga4(
    days: list[str] = typer.Argument(..., help="export days: YYYYMMDD, YYYY-MM-DD or ranges A..B (one day = one load partition)"),
    config: Path = typer.Option(..., "--config", "-c", exists=True, dir_okay=False),
    source: str = typer.Option("events", "--source", "-s", help="source name in the config"),
    intraday: bool = typer.Option(False, "--intraday", help="read the streaming (intraday) table instead of the daily export"),
    force: bool = typer.Option(False, "--force", help="allow intraday rows to replace a partition already loaded from the daily export"),
):
    """Load GA4 BigQuery Export days into bronze, applying the population
    policy; re-running a day replaces its partition."""
    from .sources.ga4_bigquery import IntradayOverDaily, SourceTableMissing, known_user_ids, load_day

    cfg = _load(config)
    src = _source(cfg, source, Ga4BigQuerySource)
    catalog = open_catalog(cfg.catalog)
    run_id = new_run_id()
    known = known_user_ids(catalog, cfg.catalog.namespace, src)
    typer.echo(f"known user ids: {known[1]}")
    records = []
    failed = 0
    for day in _days(days):
        try:
            rec = load_day(catalog, cfg.catalog.namespace, src, day, run_id, intraday=intraday, force=force, known_users=known)
        except (SourceTableMissing, IntradayOverDaily) as e:
            failed += 1
            typer.echo(f"{day}: skipped — {e}", err=True)
            continue
        records.append(rec)
        notes = json.loads(rec.notes or "{}")
        typer.echo(
            f"{day}{' (intraday)' if intraday else ''}: read {rec.rows_read} written {rec.rows_written} "
            f"filtered {rec.rows_filtered} {notes.get('filtered_by_population')} "
            f"watermark {rec.source_watermark} bytes {notes.get('bytes_processed')}"
        )
    if records:
        append_manifest(catalog, cfg.catalog.namespace, records)
    typer.echo(f"run {run_id}: {len(records)} partition(s) -> {cfg.catalog.namespace}.{src.table}" + (f", {failed} skipped" if failed else ""))
    if failed:
        raise typer.Exit(code=1)


@app.command("ga4-tables")
def ga4_tables(
    config: Path = typer.Option(..., "--config", "-c", exists=True, dir_okay=False),
    source: str = typer.Option("events", "--source", "-s"),
):
    """List the export dataset's events tables (daily and intraday) with
    row counts — 0 rows means still in the streaming buffer."""
    from .sources.ga4_bigquery import list_export_tables

    cfg = _load(config)
    src = _source(cfg, source, Ga4BigQuerySource)
    for r in list_export_tables(src):
        kind = "intraday" if r["intraday"] else "daily"
        typer.echo(
            f"{r['day']} {kind:<8} rows={r['rows']:<7} bytes={r['bytes']:<10} "
            f"modified={r['modified']:%Y-%m-%d %H:%M}Z{'  (streaming buffer)' if r['streaming_buffer'] else ''}"
        )


@app.command("runs")
def runs(
    config: Path = typer.Option(..., "--config", "-c", exists=True, dir_okay=False),
    limit: int = typer.Option(20, "--limit", "-n"),
    run_id: str | None = typer.Option(None, "--run", help="only this ingestion run id"),
    as_json: bool = typer.Option(False, "--json", help="full manifest rows (incl. contract checks) as JSON lines"),
    out: Path | None = typer.Option(None, "--out", "-o", help="with --json: write to this file (UTF-8) instead of stdout"),
):
    """Show the most recent manifest rows."""
    cfg = _load(config)
    catalog = open_catalog(cfg.catalog)
    table = catalog.load_table((cfg.catalog.namespace, MANIFEST_TABLE))
    df = table.scan().to_arrow().to_pylist()
    if run_id:
        df = [r for r in df if r["run_id"] == run_id]
    df.sort(key=lambda r: (r["load_ts"], r["partition"]), reverse=True)
    if as_json:
        lines = []
        for r in df[:limit]:
            r["load_ts"] = r["load_ts"].isoformat()
            r["contract_checks"] = json.loads(r["contract_checks"] or "[]")
            lines.append(json.dumps(r, ensure_ascii=False))
        if out:
            out.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
            typer.echo(f"{len(lines)} manifest row(s) -> {out}")
        else:
            for line in lines:
                typer.echo(line)
        return
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
