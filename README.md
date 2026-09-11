# Iceberg Lakehouse Lab

Public Data Engineering lab comparing **Databricks** and **Snowflake + dbt +
Airflow** over a shared **Apache Iceberg** foundation (AWS S3 + Glue Data
Catalog) — fed by real, GA4/Supabase-instrumented behavioral data generated
by an Agent-Based data generator (ABM) driving the actual
`matriz-senioridade` app in DEV/STG.

**Status:** 🚧 early stage — architecture and ABM design settled, no
infrastructure deployed yet.

## Start here

- [iceberg-lakehouse-lab.md](iceberg-lakehouse-lab.md) — architecture,
  principles, roadmap, comparison rubric (source of truth).
- [abm/abm_data_generator.md](abm/abm_data_generator.md) — the behavioral
  data generator's design, experiment, and agent model.
- [AGENTS.md](AGENTS.md) — durable operating context and settled decisions
  for coding agents working in this repo.

## Repository layout

Organized by **when it runs in the pipeline**, not by tool: everything
before the Databricks/Snowflake fork lives in `foundation/`, everything
after it lives in `tracks/<engine>/` — each an independently extractable
unit with its own OpenTofu state, so a losing track can be dropped (or the
ABM graduated out) without touching the rest. See
[AGENTS.md](AGENTS.md#repository-structure-follows-a-graduation-principle).

| Path | Purpose |
|---|---|
| [`foundation/`](foundation/) | Shared, pre-fork: `infra/` (S3, Glue, IAM) + `ingestion/` (Matriz/Supabase + GA4/BigQuery → Iceberg bronze) |
| [`tracks/databricks/`](tracks/databricks/) | Databricks track: its own `infra/`, `transform/` (Spark/SQL), `quality/` |
| [`tracks/snowflake/`](tracks/snowflake/) | Snowflake track: its own `infra/`, `dbt/`, `airflow/`, `quality/` |
| [`contracts/`](contracts/) | Data contracts this Lab owns (ODCS) — cross-cutting (ingestion input *and* both tracks' Gold output), so it stays outside both `foundation/` and `tracks/` |
| [`abm/`](abm/) | The behavioral data generator, as a **self-contained module** — same graduation logic as the tracks, see [abm/README.md](abm/README.md) |
| [`docs/`](docs/) | Comparison evidence, learning log |

This Lab is not the production analytics platform of any other project — see
[iceberg-lakehouse-lab.md](iceberg-lakehouse-lab.md) §1 for the exact
boundary.
