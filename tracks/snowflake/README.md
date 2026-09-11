# tracks/snowflake/

The Snowflake comparison track: SQL + dbt + Airflow — reading the shared
Iceberg tables from [`foundation/`](../../foundation/). See
[iceberg-lakehouse-lab.md](../../iceberg-lakehouse-lab.md) §10, §12
(Phase 4).

- [`infra/`](infra/) — Snowflake-specific OpenTofu (independent root/state).
- [`dbt/`](dbt/) — staging/silver and marts/gold models.
- [`airflow/`](airflow/) — local orchestration (Docker Compose).
- [`quality/`](quality/) — dbt tests and this track's data quality checks.

Not yet implemented.
