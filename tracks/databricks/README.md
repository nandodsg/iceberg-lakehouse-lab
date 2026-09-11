# tracks/databricks/

The Databricks comparison track: Spark/SQL, Delta Lake/Unity Catalog
concepts, Databricks Jobs/Workflows — reading the shared Iceberg tables from
[`foundation/`](../../foundation/). See
[iceberg-lakehouse-lab.md](../../iceberg-lakehouse-lab.md) §10, §12
(Phase 3).

No dbt, no Airflow here — this track orchestrates and transforms with
Databricks' own tooling. That's a deliberate asymmetry with
[`tracks/snowflake/`](../snowflake/), not an oversight.

- [`infra/`](infra/) — Databricks-specific OpenTofu (independent root/state).
- [`transform/`](transform/) — bronze→silver→gold Spark/SQL implementation.
- [`quality/`](quality/) — this track's data quality checks.

Not yet implemented.
