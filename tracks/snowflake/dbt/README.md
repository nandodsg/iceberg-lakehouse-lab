# tracks/snowflake/dbt/

dbt Core project for the Snowflake track. See
[iceberg-lakehouse-lab.md](../../../iceberg-lakehouse-lab.md) §10, §12
(Phase 4). Must produce Gold outputs equivalent to
[`tracks/databricks/`](../../databricks/)'s, per the comparison principle
(§15) and the contract in [`contracts/`](../../../contracts/).

Tests should include meaningful `not_null`, `unique`, `relationships`,
`accepted_values`, and custom business-rule checks (§14) — see also
[`../quality/`](../quality/).

Not yet implemented.
