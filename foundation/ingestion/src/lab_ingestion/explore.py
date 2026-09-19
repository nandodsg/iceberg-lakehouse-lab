"""Looking at the bronze — two ways to see what the extractor built,
for a human rather than for a pipeline.

`duckdb_views` writes a DuckDB database with one view per bronze table,
each pointing at that table's *current* Iceberg metadata file, so the
DuckDB UI (or any DuckDB client) can query the bronze with plain SQL and
joins. Re-running refreshes the pointers; the views never hold data.

`anatomy` prints the chain of files that makes a directory of Parquet
files an Iceberg table — catalog row -> metadata file -> current
snapshot -> manifest list -> manifests -> data files — with one line of
explanation per level. Managed platforms hide this chain by design; the
point of running local-first is to be able to look at it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

from pyiceberg.catalog import Catalog
from pyiceberg.conversions import from_bytes
from pyiceberg.table import Table

# ---- DuckDB views ---------------------------------------------------


def duckdb_views(catalog: Catalog, namespace: str, db_path: Path) -> list[tuple[str, str]]:
    """(view name, metadata file) for every table in the namespace, after
    writing the views into `db_path` (created if missing). Each table gets
    three views: the data (`<name>`), its snapshot history
    (`<name>__snapshots`) and the manifests/data files of the current
    snapshot (`<name>__files`) — the anatomy, as tables."""
    import duckdb

    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    con.sql("INSTALL iceberg; LOAD iceberg")
    out = []
    for ident in sorted(catalog.list_tables(namespace)):
        table = catalog.load_table(ident)
        name = ident[-1]
        meta = table.metadata_location.replace("'", "''")
        con.sql(f'CREATE OR REPLACE VIEW "{name}" AS SELECT * FROM iceberg_scan(\'{meta}\')')
        con.sql(
            f'CREATE OR REPLACE VIEW "{name}__snapshots" AS '
            f"SELECT * FROM iceberg_snapshots('{meta}') ORDER BY sequence_number DESC"
        )
        con.sql(
            f'CREATE OR REPLACE VIEW "{name}__files" AS '
            f"SELECT * FROM iceberg_metadata('{meta}') ORDER BY file_path"
        )
        out.append((name, table.metadata_location))
    con.close()
    return out


def start_ui(db_path: Path, announce: Callable[[str], None] = print) -> None:
    """Start the DuckDB UI on the database, announce its URL, and block
    until interrupted (the UI lives only while this process does)."""
    import time

    import duckdb

    con = duckdb.connect(str(db_path))
    (msg,) = con.sql("CALL start_ui_server()").fetchone()
    announce(f"{msg} - Ctrl+C to stop")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        con.close()


# ---- Anatomy ----------------------------------------------------------


def _fmt_bytes(n: int | None) -> str:
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _ts(ms: int | None) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ") if ms else "?"


def _short(t: str) -> str:
    """Nested types shown as their outer shape only."""
    return t if "<" not in t else t.split("<", 1)[0] + "<...>"


def _rel(path: str, root: str) -> str:
    return path[len(root) :].lstrip("/\\") if path.startswith(root) else path


def anatomy(catalog: Catalog, namespace: str, name: str, max_files: int = 40) -> Iterator[str]:
    """Yield the lines of the anatomy report for one table."""
    table: Table = catalog.load_table((namespace, name))
    md = table.metadata
    root = md.location.rstrip("/")
    io = table.io
    yield f"{namespace}.{name}"
    yield f"  location: {root}"
    yield ""

    # 1. catalog row
    yield "1. CATALOG ROW — the only thing the catalog stores: which metadata file is current."
    yield f"   {catalog.name} ({type(catalog).__name__}) -> {_rel(table.metadata_location, root)}"
    yield ""

    # 2. metadata file
    n_meta = len(md.metadata_log) + 1
    schema = table.schema()
    spec = table.spec()
    part = ", ".join(f"{f.name} ({f.transform})" for f in spec.fields) or "none"
    yield f"2. METADATA FILE — the table definition, rewritten on every commit (this is version {n_meta}; older versions stay on disk as history)."
    yield f"   format v{md.format_version}; schema id {schema.schema_id}: {len(schema.fields)} columns; partitioned by: {part}"
    yield f"   {len(md.snapshots)} snapshot(s) in history; current: {md.current_snapshot_id}"
    top = [f"{f.name}: {_short(str(f.field_type))}" for f in schema.fields]
    yield "   columns: " + "; ".join(top[:12]) + (f"; ... +{len(top) - 12} more" if len(top) > 12 else "")
    yield ""

    snap = table.current_snapshot()
    if snap is None:
        yield "3. SNAPSHOT — none yet (empty table)."
        return
    summ = dict(snap.summary.additional_properties) if snap.summary else {}
    op = snap.summary.operation.value if snap.summary else "?"
    yield "3. CURRENT SNAPSHOT — one immutable version of the table; every load commits a new one, readers see exactly one."
    yield f"   id {snap.snapshot_id}, {_ts(snap.timestamp_ms)}, operation={op}, parent={snap.parent_snapshot_id}"
    keys = ("added-records", "deleted-records", "total-records", "added-data-files", "deleted-data-files", "total-data-files", "total-files-size")
    yield "   summary: " + ", ".join(f"{k}={summ[k]}" for k in keys if k in summ)
    parent = table.snapshot_by_id(snap.parent_snapshot_id) if snap.parent_snapshot_id else None
    if parent is not None and parent.summary:
        psumm = dict(parent.summary.additional_properties)
        yield (
            f"   previous: id {parent.snapshot_id}, {_ts(parent.timestamp_ms)}, operation={parent.summary.operation.value}, "
            + ", ".join(f"{k}={psumm[k]}" for k in keys if k in psumm)
            + "  (a partition reload is two commits: delete the old files, append the new)"
        )
    yield ""

    # 4. manifest list
    manifests = snap.manifests(io)
    yield "4. MANIFEST LIST — the snapshot's index: which manifests (and therefore which files) belong to this version."
    yield f"   {_rel(snap.manifest_list, root)} -> {len(manifests)} manifest(s)"
    yield ""

    # 5. manifests + 6. data files
    yield "5. MANIFESTS — each lists data files with their partition and per-column statistics (the stats are what lets a query skip files)."
    yield "6. DATA FILES — the Parquet files, one or more per partition; a reload replaces a partition's files, it never edits them."
    run_field = next((f for f in schema.fields if f.name == "_ingestion_run_id"), None)
    shown = 0
    total_rows = total_bytes = 0
    for m in manifests:
        entries = m.fetch_manifest_entry(io, discard_deleted=True)
        yield (
            f"   manifest {_rel(m.manifest_path, root)}: added={m.added_files_count} existing={m.existing_files_count} "
            f"deleted={m.deleted_files_count}, snapshot {m.added_snapshot_id}"
        )
        for e in entries:
            df = e.data_file
            total_rows += df.record_count
            total_bytes += df.file_size_in_bytes
            if shown >= max_files:
                continue
            shown += 1
            partition = ", ".join(f"{f.name}={v}" for f, v in zip(spec.fields, df.partition)) or "-"
            run = ""
            if run_field is not None and df.lower_bounds and run_field.field_id in df.lower_bounds:
                run = f", load {from_bytes(run_field.field_type, df.lower_bounds[run_field.field_id])}"
            yield f"      {e.status.name.lower():<8} {_rel(df.file_path, root)}  [{partition}] {df.record_count} rows, {_fmt_bytes(df.file_size_in_bytes)}{run}"
    hidden = sum(m.added_files_count + m.existing_files_count for m in manifests) - shown
    if hidden > 0:
        yield f"      ... {hidden} more file(s) (raise --max-files)"
    yield ""
    yield f"   total: {total_rows} rows in {shown + max(hidden, 0)} data file(s), {_fmt_bytes(total_bytes)}"
