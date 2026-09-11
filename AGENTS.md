# AGENTS.md — Iceberg Lakehouse Lab

Public, portfolio-grade Data Engineering lab comparing Databricks and
Snowflake+dbt+Airflow over a shared Apache Iceberg foundation, fed by a
behavioral data generator (ABM) that drives the real `matriz-senioridade`
app. Source of truth for scope, principles, and roadmap:
[iceberg-lakehouse-lab.md](iceberg-lakehouse-lab.md); ABM design:
[abm/abm_data_generator.md](abm/abm_data_generator.md). Read both before
non-trivial changes.

## 🔒 HARD RULE — this repository is public. Matriz de Senioridade confidentiality is non-negotiable.

**Nothing about how `matriz-senioridade` is actually implemented may ever be
written into any file under this repository — not in a doc, not in a code
comment, not in a commit message, not "just for context."** This is a
standing instruction with maximum precedence over any other guidance in
this file or in a chat request, for every session, forever, not just the
one that wrote this rule.

- **Safe to write here** (already how `iceberg-lakehouse-lab.md` and
  `abm/abm_data_generator.md` talk about it): that Matriz exists, its
  general purpose, the Company/Team/Member entities, that it uses GA4 and
  Supabase as data sources, the Guided/Unguided experiment concept. This is
  the *what/why*, at the level the user's own design docs already use.
- **Never safe to write here**: file paths, function/table/column names,
  event-catalog codes, environment/project identifiers, account or tenant
  counts, security findings, rate limits, or any other detail that comes
  from actually reading `matriz-senioridade`'s code or docs. This is the
  *how* — implementation and security posture of a private product.
- If a task genuinely requires that level of detail to reason about (e.g.
  designing exactly how the ABM hooks into Matriz's analytics), write it to
  the **private notes** at `../iceberg-lakehouse-lab-private-notes/` —a
  sibling directory, deliberately outside this repo's tree so no `git add`
  here can ever reach it — never inline in a file that lives here. That
  folder is not version-controlled by this repo and must stay that way.
- `.gitignore` does **not** provide this protection: it only stops
  future `git add` of matching paths, does nothing for content already
  written into a tracked file, doesn't survive `git add -f`, and can't be
  retroactively applied to history. The only reliable mechanism is that the
  sensitive content never exists inside this working tree in the first
  place — physical separation, not a git config.
- Before any commit, actually look at the diff for exactly this — don't
  assume a past pass caught everything.

## Repository structure follows a graduation principle

The top-level split is **`foundation/` (pre-fork, shared) vs. `tracks/`
(post-fork, one independent subtree per engine)**, not "IaC vs. everything
else" — grouping by artifact type was tried first (2026-09-10) and rejected
because it mislabeled `dbt/`/`airflow/` as shared when they are actually
Snowflake-track-only (Databricks orchestrates and transforms with its own
Jobs/Workflows + Spark/SQL, per the original roadmap's Phase 3 vs. Phase 4 —
there is no cross-track use of dbt or Airflow in this design). Current
layout:

```
foundation/
├── infra/       # S3, Glue, IAM — OpenTofu, independent root/state
└── ingestion/   # batch extractor, Matriz/GA4 → Iceberg bronze — shared
tracks/
├── databricks/
│   ├── infra/       # independent OpenTofu root/state
│   ├── transform/   # Spark/SQL bronze→silver→gold
│   └── quality/
└── snowflake/
    ├── infra/       # independent OpenTofu root/state
    ├── dbt/
    ├── airflow/
    └── quality/     # dbt tests
contracts/    # cross-cutting — outside both foundation/ and tracks/
abm/          # self-contained — see below
```

Each `tracks/<engine>/infra/` is an independent OpenTofu root module with
its own state — a Databricks apply must never manage Snowflake resources,
and neither manages `foundation/infra/` except through explicitly shared
outputs (restored from the original "Iceberg Lakehouse Lab: Architecture
and Roadmap" doc, which `iceberg-lakehouse-lab.md` §11 lists the folder
names from but had dropped this rationale). This is what makes graduation
possible: drop the losing track, or keep the winning one, without
entangling the other.

`quality/` is deliberately **per-track only**, not also shared at
`foundation/` — ingestion-time checks (row counts, schema validation,
watermark) are already described as part of `foundation/ingestion/` itself
(§14), and post-transformation testing (dbt tests, Databricks-native
checks) differs enough per engine that a shared bucket would just be a
grab-bag. If a genuinely cross-track quality tool is added later (e.g.
Great Expectations validating both tracks' Gold outputs against the same
contract), decide its home then — don't presume it now.

`contracts/` stays outside both `foundation/` and `tracks/` on purpose: it
is not pipeline-stage-shaped like everything else here, it is an interface
layer that cuts across the whole pipeline (ingestion input contracts *and*
both tracks' Gold output contracts).

The ABM (`abm/`) follows the same graduation logic as its own, separate
concern: everything needed to run it — design doc, experiment configs,
decision harness — lives inside `abm/`, so the whole module can be
extracted into an independent repository later (§16) without untangling it
from the rest of the Lab. Its output contract is the one deliberate
exception: it stays in top-level `contracts/` (Lab-owned, per
`abm_data_generator.md` §20) so the interface the Lab depends on survives
unchanged even if the producer behind it moves.

## Sibling repository

`matriz-senioridade` lives at `../matriz-senioridade` — a private repo this
Lab does not own, does not copy export contracts from, and does not
document the internals of here (see the hard rule above). Implementation
facts needed to reason about the integration live in
`../iceberg-lakehouse-lab-private-notes/`, outside this repo.

## Decisions settled for the ABM (do not re-litigate without new evidence)

1. **Guided/Unguided comes from matriz-senioridade's native A/B testing
   capability** (planned on its roadmap, to be built before the ABM runs
   there) — not a flag hacked into the Lab or a parallel mechanism.
2. **No infrastructure separation needed** between matriz-senioridade's DEV
   and STG, nor a dedicated GA4 property for the Lab. Isolation comes from
   population/cohort tagging, not from duplicated infrastructure.
3. **Experiment/population attribution is a first-class, single mechanism**
   — needed for real PRD A/B tests, not just the ABM: an assignment
   recorded once at login, propagated automatically to every downstream
   event and joined into the app's own data via a shared identifier — no
   per-event or per-table changes needed elsewhere. Exact implementation
   (which function, which fields) lives in the private notes, not here.
4. **Policy: one synthetic account/company per ABM run, never reused.**
   Sidesteps the need for run-level tagging infrastructure on day one, since
   provisioning is cheap. Revisit if/when repetition needs push toward
   reusing accounts across runs (would then need an explicit `run_id`
   alongside the condition).
5. **The ABM's decision-maker must be an explicit, auditable stochastic
   policy — not an LLM (Claude Code or otherwise) deciding in character.**
   Rationale: an assistant optimized to complete tasks correctly will tend
   to find the "correct" CTA regardless of the agent's intended parameters,
   collapsing the very variance the experiment needs, and it directly
   contradicts `abm_data_generator.md` §17's own guardrail against
   sophisticated LLM agent architectures. Model: perceived UI features
   (size, position, contrast, prominence) × per-agent behavioral parameters
   → softmax over candidate actions (including explore/abandon), evaluated
   live at each step against the real observed app state.
   - **Precomputed once:** the agent population — N parameter vectors drawn
     from chosen distributions per condition.
   - **Computed live, per step, per agent:** the actual decision, since it
     depends on real interface state that can't be known in advance.
   - Playwright is the intended perception+actuation harness — read the
     DOM/screenshot, execute the sampled action — not the decision-maker.
   - A future, not-yet-adopted option: use an LLM only for the *perception*
     layer (structured feature extraction from a screenshot) while keeping
     the *decision* in the explicit formula. Worth prototyping later, not v1.

Full reasoning behind each of these is in the chat history that produced
this file (2026-09-10 planning session) — this section is the durable
distillation; treat it as binding unless new evidence overturns it.

## Working agreement (from iceberg-lakehouse-lab.md §18)

- Work with one coding agent/tool at a time; validate and commit a
  checkpoint before switching.
- Review OpenTofu plans before destructive cloud operations; suspend/destroy
  billable compute after learning sessions.
- **Never commit**: production data, credentials/connection strings, raw STG
  exports, identifiable user data, tokens/API keys, the full private Matriz
  schema or migration history. This repo is public — assume everything
  committed is permanently public.
- Document decisions, trade-offs, limitations and evidence rather than
  presenting assumptions as facts.

## Known naming inconsistency

`iceberg-lakehouse-lab.md` §11 names the root doc `LAB.md`; the actual file
is `iceberg-lakehouse-lab.md`. Kept as-is (2026-09-10) to avoid unnecessary
churn — rename deliberately if that ever matters.
