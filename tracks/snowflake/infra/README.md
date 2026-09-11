# tracks/snowflake/infra/

Snowflake-specific infrastructure (warehouse, SQL) consuming the shared
Iceberg foundation. Independent OpenTofu root module with its own state —
must never manage Databricks or foundation resources except through
explicitly shared outputs. See
[iceberg-lakehouse-lab.md](../../../iceberg-lakehouse-lab.md) §9-10, §12.

Not yet implemented.
