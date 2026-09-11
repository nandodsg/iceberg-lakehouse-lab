# tracks/databricks/transform/

Bronze→silver→gold implementation using Spark SQL/PySpark, reading the
shared Iceberg tables from [`foundation/`](../../../foundation/) through
Databricks' supported catalog path. See
[iceberg-lakehouse-lab.md](../../../iceberg-lakehouse-lab.md) §10, §12
(Phase 3). Must produce Gold outputs equivalent to
[`tracks/snowflake/`](../../snowflake/)'s, per the comparison principle
(§15) and the contract in [`contracts/`](../../../contracts/).

Not yet implemented.
