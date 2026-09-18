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

lab-ingest abm-jsonl -c /path/to/config.yaml runs/*.jsonl   # ABM batches -> bronze.abm_decision_steps
lab-ingest tables    -c /path/to/config.yaml                # bronze tables and row counts
lab-ingest runs      -c /path/to/config.yaml                # the manifest, most recent first
pytest                                                      # synthetic fixtures only
```

## Status

- `abm_decision_steps`: implemented; contract v1.0.0 validated against
  the full output of the first experiment (16 batch files, 23,847
  decision-steps, 303 agents) and loaded locally with all contract checks passing on
  every complete batch and failing — as designed — on the two aborted
  ones.
- `app_events` (GA4 BigQuery Export): next.
- `app_entities_*`: waits on the application's entities export contract
  and read-only export views.
- Shared AWS catalog: after the local acceptance passes.
