# tracks/snowflake/quality/

This track's data quality checks: dbt tests (`not_null`, `unique`,
`relationships`, `accepted_values`, custom business rules) and, later,
Great Expectations experiments. See
[iceberg-lakehouse-lab.md](../../../iceberg-lakehouse-lab.md) §14.

If a cross-track quality tool (e.g. Great Expectations validating both
tracks' Gold outputs against the same contract) is ever added, decide then
whether it lives here, in `tracks/databricks/quality/`, or as its own
shared concern — don't presume it now.

Not yet implemented.
