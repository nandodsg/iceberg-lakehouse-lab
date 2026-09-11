# tracks/databricks/quality/

This track's data quality checks on top of the bronze→silver→gold Spark/SQL
implementation. See
[iceberg-lakehouse-lab.md](../../../iceberg-lakehouse-lab.md) §14.

Not yet decided how these checks are implemented (PySpark-native assertions,
Great Expectations, or something else) — open decision, not urgent until
[`transform/`](../transform/) exists. If a cross-track quality tool (e.g.
Great Expectations validating both tracks' Gold outputs against the same
contract) is ever added, decide then whether it lives here, in
`tracks/snowflake/quality/`, or as its own shared concern — don't presume it
now.

Not yet implemented.
