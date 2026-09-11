# foundation/ingestion/

Custom batch extractor moving approved, privacy-safe exports from Matriz/
Supabase and GA4/BigQuery into S3/Iceberg bronze tables — shared by both
comparison tracks. See
[iceberg-lakehouse-lab.md](../../iceberg-lakehouse-lab.md) §6-8, §14.

Responsible for recording, where applicable: row counts, schema validation,
load timestamp, source watermark, rejected records, contract validation
results. This is also where the ingestion-time quality checks live — there
is no separate shared `quality/` folder; track-specific testing (dbt tests,
etc.) lives under each `tracks/<engine>/quality/` instead.

This is also where GA4 events and Supabase entity rows get joined by
`user_id` and attributed to their experiment population/condition (see the
ABM experiment-assignment design in
[abm/experiments/README.md](../../abm/experiments/README.md)) — that join
belongs here, not inside the Matriz application.

Not yet implemented.
