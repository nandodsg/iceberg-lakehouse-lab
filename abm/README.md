# abm/

The Agent-Based / E2E behavioral data generator, as a **self-contained
module** — same graduation rationale as `tracks/databricks/` and
`tracks/snowflake/` being independent, extractable comparison tracks (see
[iceberg-lakehouse-lab.md](../iceberg-lakehouse-lab.md) §11): the ABM has its
own graduation criteria too
([abm_data_generator.md](abm_data_generator.md) §19), and everything it
needs to become an independently-extractable repository lives under this one
directory.

- [`abm_data_generator.md`](abm_data_generator.md) — full design: purpose,
  research question, agent/perception/decision model, scope constraints.
- [`experiments/`](experiments/) — experiment definitions, run configs, and
  results; also the settled decisions log for how the ABM is implemented.

**What deliberately does NOT live here:** the ABM's own behavioral output
contract stays in the top-level [`contracts/`](../contracts/) directory, not
inside this module — `abm_data_generator.md` §20 assigns ownership of that
contract to the Lab, not to the ABM, precisely so the interface the Lab
depends on stays stable and Lab-controlled if this whole module is ever
extracted into its own repository. Only the *implementation* (population
design, decision harness, run configs) is meant to move with `abm/` on
graduation — the contract does not.

Not yet implemented.
