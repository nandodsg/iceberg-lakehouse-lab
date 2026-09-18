# contracts/

Data contracts **owned by this Lab**, using the latest Open Data Contract
Standard (ODCS): the ABM behavioral output contract, and the Gold output
contracts that Databricks and Snowflake must both satisfy. See
[iceberg-lakehouse-lab.md](../iceberg-lakehouse-lab.md) §7-8, §11 and
[abm/abm_data_generator.md](../abm/abm_data_generator.md) §20.

Lives outside both [`foundation/`](../foundation/) and
[`tracks/`](../tracks/) on purpose — it isn't pipeline-stage-shaped like
everything else in this repo, it's an interface spanning the ingestion
input contract *and* both tracks' Gold output contracts.

The ABM output contract lives here — not under `abm/` — deliberately: it is
the interface the Lab depends on, so it must survive unchanged if `abm/` is
ever extracted into its own repository on graduation. See
[abm/README.md](../abm/README.md).

This directory does **not** contain matriz-senioridade's export contracts —
those remain authoritative in that repository. The Lab only consumes them.

## Contents

- [`abm-behavioral-events.contract.yaml`](abm-behavioral-events.contract.yaml)
  — v1.0.0, active (2026-09-18). One row per ABM agent decision-step;
  validated against the real harness output of the first experiment and
  enforced at ingestion by `foundation/ingestion/` (its `quality:` rules
  of type `custom` name the checks that layer executes).
