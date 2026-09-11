# tracks/

Everything that runs **after the fork** — one independent, engine-specific
implementation per comparison track, both reading the same
[`foundation/`](../foundation/) output. See
[iceberg-lakehouse-lab.md](../iceberg-lakehouse-lab.md) §9-12, §15-16.

- [`databricks/`](databricks/) — Spark/SQL, Databricks Jobs/Workflows.
- [`snowflake/`](snowflake/) — SQL + dbt + Airflow.

Each track owns its own infra (independent OpenTofu root/state), its own
transformation code, and its own quality checks — nothing here is shared
with the other track. This is what makes graduation possible: drop the
losing track, or keep the winning one, without touching the other (see
[AGENTS.md](../AGENTS.md)).
