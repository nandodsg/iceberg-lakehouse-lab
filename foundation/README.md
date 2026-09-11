# foundation/

Everything that runs **before the fork** — shared by both comparison
tracks, produced once, read by both. See
[iceberg-lakehouse-lab.md](../iceberg-lakehouse-lab.md) §9-11.

- [`infra/`](infra/) — S3, Glue Data Catalog, IAM, budget/tagging guardrails
  (OpenTofu).
- [`ingestion/`](ingestion/) — batch extraction from Matriz/Supabase and
  GA4/BigQuery into S3/Iceberg bronze tables.

Both comparison tracks (`tracks/databricks/`, `tracks/snowflake/`) read the
same Iceberg bronze tables this produces — nothing here is specific to
either engine.
