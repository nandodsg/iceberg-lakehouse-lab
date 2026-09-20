# foundation/ingestion/

Custom batch extractor moving approved, privacy-safe exports from Matriz/
Supabase and GA4/BigQuery — plus the ABM's own behavioral output — into
Iceberg bronze tables shared by both comparison tracks. See
[iceberg-lakehouse-lab.md](../../iceberg-lakehouse-lab.md) §6-8, §14.

Responsible for recording, where applicable: row counts, schema validation,
load timestamp, source watermark, rejected records, contract validation
results. This is also where the ingestion-time quality checks live — there
is no separate shared `quality/` folder; track-specific testing (dbt tests,
etc.) lives under each `tracks/<engine>/quality/` instead.

Joining GA4 events, entity rows and ABM decision-steps by the shared user
identifier, and attributing them to their experiment population/condition
(see [abm/experiments/README.md](../../abm/experiments/README.md)), is the
**Lab's** job, never the application's. Bronze keeps each source at its
own grain; this layer's acceptance test proves the join closes, and each
track materializes it in its own silver layer.

## Design

**Three bronze tables, one per source, at the source's own grain, no
join.**

| bronze table | source | governed by | unit of (re)load |
|---|---|---|---|
| `abm_decision_steps` | ABM harness JSONL (one file per batch) | [`contracts/abm-behavioral-events`](../../contracts/abm-behavioral-events.contract.yaml) (Lab-owned) | the batch file |
| `app_events` | the application's GA4 property, via its BigQuery Export | the application's analytics export contract | one export day |
| `app_entities_*` | read-only export views of the application's database | the application's entities export contract | one snapshot |

Every bronze row carries provenance (`_ingestion_run_id`, `_load_ts`,
`_source_watermark`, `_source_file`/`_source_batch`), and every load
writes one row per partition to `_ingestion_runs` — the manifest §14 asks
for: rows read/written/rejected/filtered, source watermark, load
timestamp, contract id/version, contract check results, schema hash.
Rows that fail contract validation go to `<table>__rejected` with the
reason and the raw line, never silently dropped or "fixed".

**Contracts drive the extractor.** Each source is read through its ODCS
v3 contract: `schema:` gives the bronze Arrow schema and row validation
(required, type, enum); `quality:` entries are recorded in the manifest,
and those of `type: custom` with `engine: lab-ingestion` name a check
this package executes on every load (e.g. `terminal_row_per_agent` — a
batch cut short fails it, which is the signal that it *was* cut short).
Contract-open structures (the ABM's `agent_parameters`,
`decision_signals`) are stored as JSON text, so no key set is baked into
bronze and any engine can parse them.

**Idempotent per partition.** Reloading a batch file / an export day / a
snapshot overwrites exactly that partition (Iceberg overwrite with a
filter), never duplicates.

**Local first.** Development and acceptance run against a local Iceberg
catalog (SQLite catalog + a warehouse directory, zero cloud); switching
to the shared AWS foundation (`foundation/infra/`: S3 + Glue) is a change
of `catalog:` in the configuration, not of code.

**Public code, private configuration** — the same split as the ABM
harness. This package knows source *types* (a GA4 BigQuery Export
dataset, a Postgres schema of export views, JSONL under a contract); the
real identifiers, dataset names, promoted user-property names and
connection details for a deployment live outside this repository and are
passed with `--config`. [`config.example.yaml`](config.example.yaml)
documents the shape with placeholders. Nothing about the target
application's implementation is, or may be, in this tree (see
[AGENTS.md](../../AGENTS.md)).

## Usage

```bash
cd foundation/ingestion
uv venv .venv && uv pip install -e ".[dev]"        # + [bigquery] / [postgres] / [glue] as needed

lab-ingest abm-jsonl  -c /path/to/config.yaml runs/*.jsonl        # ABM batches -> bronze.abm_decision_steps
lab-ingest ga4-tables -c /path/to/config.yaml                     # which export days exist (daily / intraday)
lab-ingest ga4        -c /path/to/config.yaml 2026-01-01..2026-01-03   # export days -> bronze.app_events
lab-ingest ga4        -c /path/to/config.yaml 2026-01-04 --intraday    # today's streaming table, replaced by the daily later
lab-ingest pg-probe   -c /path/to/config.yaml                     # what the export role can reach (and cannot)
lab-ingest entities   -c /path/to/config.yaml                     # one full snapshot of the export views -> bronze.app_entities_*
lab-ingest tables     -c /path/to/config.yaml                     # bronze tables and row counts
lab-ingest runs       -c /path/to/config.yaml                     # the manifest, most recent first
lab-ingest duckdb     -c /path/to/config.yaml --ui                # SQL over the bronze in the DuckDB UI (see below)
lab-ingest anatomy app_events -c /path/to/config.yaml             # the files behind one Iceberg table, explained
pytest                                                            # synthetic fixtures only
```

## Looking at the bronze

A directory of Parquet and Avro files is not something a person can
judge by opening it. Two commands exist only for that — for the human
who has to decide whether what the extractor built makes sense:

- `lab-ingest duckdb` writes a DuckDB database with **one view per
  bronze table**, each pointing at that table's current Iceberg
  metadata file (DuckDB's `iceberg` extension reads the tables
  directly; the pyiceberg SQL catalog is not one DuckDB understands,
  so the views pin the metadata file and are refreshed by re-running
  the command after a load). With `--ui` it starts the DuckDB UI
  (`http://localhost:4213`): plain SQL, joins across bronze tables and
  the manifest, no code. Each table also gets `<name>__snapshots` (its
  commit history) and `<name>__files` (the manifests and data files of
  the current snapshot) — the anatomy below, as tables you can query.
  It is a local convenience — a shared catalog (Glue) makes it
  unnecessary.
- `lab-ingest anatomy <table>` prints the chain that makes those files
  a table — catalog row → metadata file → current snapshot → manifest
  list → manifests → data files, with the partition, row count, size
  and the ingestion run that wrote each file (read from the manifest's
  column statistics) — one line of explanation per level. Managed
  platforms hide this chain by design; running local-first is the
  chance to see it.

## Status — what the local acceptance proved

All three sources are implemented and loaded against the local catalog.
This is the state the shared AWS catalog inherits unchanged.

- `abm_decision_steps` — contract v1.0.0 validated against the full
  output of the first experiment (16 batch files, 23,847 decision-steps,
  303 agents) and loaded with every contract check passing on every
  complete batch and failing — as designed — on the two aborted ones.
- `app_events` (GA4 BigQuery Export) — one export day = one partition;
  the daily table is the truth, the intraday (streaming) table loads
  only under `--intraday` into the same partition, flagged, and is
  replaced by the daily one (the reverse is refused). The export's
  nested structure is kept as Iceberg list/struct columns; `event_ts`
  and the configured user properties are promoted to top-level columns.
  A population policy runs before the write and is counted in the
  manifest: rows tagged with an allowed population are kept, untagged
  rows only when their user id is already known from another bronze
  source (a login fires before the tag exists), everything else is
  filtered out. **Acceptance**: the per-batch GA4 × ABM cross-check that
  the first experiment ran directly against BigQuery is reproduced from
  the two local bronze tables alone, number for number, for every batch
  with a reference. The one difference — a single login event in one
  batch — is the consolidated daily table being more complete than the
  intraday snapshot the experiment had read at the time; that is exactly
  why the daily table is the truth here.
- `app_entities_*` (read-only export views) — one execution = one full
  snapshot of every configured view, all under the same snapshot id
  (the partition); a snapshot id reloaded is replaced. Full snapshots,
  not increments, because a physical delete in the source leaves no
  tombstone — only the difference between two snapshots shows it. Each
  view is read through its object in the application's entities export
  contract (a multi-object ODCS contract): the column list is the
  contract's, never `select *`, and the view's actual columns and types
  are compared with the contract before anything is read — a view that
  drifted is rejected and the rejection recorded in the manifest, never
  adapted to. The source watermark is the latest row-update timestamp
  the export views expose. The database role is expected to see the
  export schema and nothing else; `pg-probe` verifies that with a real
  `select` attempt on every table outside it. The DSN comes from an
  environment variable or a `.env` next to the configuration, never
  from a file in any repository. **Acceptance**: a full snapshot loaded
  with every view matching its contract object column for column and
  nothing rejected; where state exists, the relationship the silver join
  needs holds — one creation event in `app_events` = one entity row
  created by that user.
- `duckdb` / `anatomy` — implemented (see *Looking at the bronze*).

### A finding, not a failure: the first experiment has no entity leg

The three-way join — events × decision-steps × entities — cannot be
closed for the first experiment's batches, and never will be. The
harness discards each batch's synthetic accounts when the batch ends
(the "one account per run, never reused" policy — see
[abm/experiments/README.md](../../abm/experiments/README.md)), the
source removes them physically, and no snapshot of the export views
existed at the time. The extractor reports exactly what the source
holds — none of those agents — and that is the correct answer, not a
gap in the pipeline. Two consequences:

- **Operating rule from now on**: `lab-ingest entities` runs *before* a
  batch's accounts are discarded, and again after. The difference
  between the two snapshots is the deletion, demonstrated with data
  rather than assumed — the property the snapshot design above exists
  for.
- The first dataset with all three legs will be the next experiment
  run, written directly into the shared catalog. The first experiment's
  batches remain what they are — the evidence for its hypothesis and for
  the events × decision-steps cross-check above — with the entity leg
  absent by construction.

### Next

- [`foundation/infra/`](../infra/) (S3 + Glue + cost guardrails,
  OpenTofu): a change of `catalog:` in the configuration, then the same
  loads and the same cross-check against the shared catalog.
- Deferred, each with its trigger: validating `app_events` against the
  application's analytics export contract the way entities already are
  (once that contract is reachable from the extractor's configuration);
  a dedicated read-only service account for BigQuery in place of
  developer credentials (when loads leave the developer's machine); a
  small explorer page on top of the DuckDB views, only if the managed
  consoles leave a gap the *Looking at the bronze* commands don't cover.
