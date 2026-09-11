# foundation/infra/

Resources shared by both comparison tracks: AWS S3 (Iceberg data), AWS Glue
Data Catalog, networking, and IAM. Nothing here is specific to Databricks or
Snowflake — see [iceberg-lakehouse-lab.md](../../iceberg-lakehouse-lab.md)
§9-11.

This is an independent OpenTofu root module with its own state — a
Databricks or Snowflake apply must never manage these resources except
through explicitly shared outputs (see the graduation rationale in
[AGENTS.md](../../AGENTS.md)).

Not yet implemented.
