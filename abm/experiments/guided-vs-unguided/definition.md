# Experiment: Guided vs. Unguided

**`experiment_id`: `guided-vs-unguided-v1`** — this is the exact string
that will appear in the `experiment_id` field of every event this
experiment produces (see
[`contracts/abm-behavioral-events.contract.yaml`](../../../contracts/abm-behavioral-events.contract.yaml)).
This document is what that contract's free-form fields
(`agent_parameters`, `condition`, `journey_stage`, `decision_signals`)
resolve against for this experiment specifically.

Status: **draft, not yet run.** Research question and hypothesis (H1) are
defined in [`abm_data_generator.md`](../../abm_data_generator.md) §3-4 —
not repeated here, this document only adds the concrete configuration
needed to actually execute it.

## Entry point

Agents start authenticated, already on the Gestão de Entidades landing
page — **not** the application's general hub. Starting from a general hub
would test a different research question (does a naive agent discover
the right product area among unrelated ones at all — a valid future
experiment, see "Open questions" below) that this experiment doesn't have
parameters or hypotheses for, and would confound the Guided/Unguided
comparison with unrelated navigation noise. Defining where the study
begins is a legitimate experimental-design boundary, not an instance of
telling the agent which action is correct within the journey.

## Exploration is unrestricted, but the success criterion is not

The agent's action space is never artificially narrowed — `explore` may
navigate anywhere, including outside Gestão de Entidades entirely. The
restriction lives in how completion is judged, not in what the agent can
do:

> **`journey_completed` counts toward H1 only if** Company≥1 ∧ Team≥1 ∧
> Member≥1 **and** the agent's `screen` trajectory never left the Gestão
> de Entidades route prefix for the duration of the run.

This is a **derived, analysis-time rule**, not a contract field — every
event already carries `screen`, so "did this run ever leave scope" is
computable from the event stream itself. No harness or contract change
needed.

This also opens a plausible secondary hypothesis worth tracking, not just
a data-cleaning rule: agents may leave scope *more often* under
`unguided` than `guided`, since guided's redirect anchors the agent back
into the flow after each step and unguided doesn't. Worth reporting the
leave-scope rate per condition alongside the primary metric, not
discarding it as noise.

## Abandonment vocabulary

Two `action` values (`abandon_idle`, `abandon_logout` — see the
contract), both terminal:

- **`abandon_idle`**: the agent stops acting; the run ends at the
  10-minute timeout with no further event. Covers every real-world
  equivalent that produces the same observable signature — switched
  tabs, closed the browser, or simply went quiet — deliberately not
  distinguished further, since none of them produce a distinguishing
  event either way.
- **`abandon_logout`**: an explicit, observable sign-out action taken
  before the timeout.

Leaving the product area (e.g. navigating to an unrelated Matriz product)
is **not** a third abandon variant — it's ordinary `explore`/`navigate`.
If the agent never returns, that shows up as the run having no further
events from within Gestão de Entidades, which the exclusion rule above
already handles; it is not recorded as a distinct action value.

## Journey and journey_stage vocabulary

Company → Team → Member, 10-minute completion window
(`abm_data_generator.md` §3). Valid `journey_stage` values for this
experiment: `none`, `company`, `team`, `member` — furthest stage reached,
not necessarily sequential (an agent may attempt Team before Company
succeeds, depending on condition/behavior).

## condition vocabulary

Two values for this experiment: `guided`, `unguided` (`abm_data_generator.md`
§5). **`unguided` cannot run yet** — blocked on matriz-senioridade's native
A/B testing capability becoming available in STG. This experiment
definition covers both conditions so it's ready the moment that
dependency clears — it does not mean both run now.

## agent_parameters — the 5 parameters, their range, and how they're sampled

All 5 parameters from `abm_data_generator.md` §6, normalized to **[0, 1]**
(no principled reason yet to use a different scale — revisit if a
parameter turns out to need one, e.g. `time_cost` might eventually want
units tied to the 10-minute window instead of an abstract [0,1] weight).

| Parameter | Meaning | Direction |
|---|---|---|
| `goal_seeking` | reward weight for finding the correct CTA quickly / completing the current stage | higher → more likely to progress efficiently |
| `exploration` | propensity to explore alternative elements instead of progressing | higher → more likely to deviate from the direct path |
| `visual_sensitivity` | sensitivity to visual complexity/salience of perceived elements | higher → perceived salience influences attention more strongly |
| `time_cost` | cost weight associated with elapsed time / pressure from the 10-minute limit | higher → more likely to rush or abandon as time passes |
| `abandonment_propensity` | propensity to abandon when perceived progress/expected reward is insufficient | higher → more likely to abandon early |

**Sampling, per agent, independently per parameter:**
`Uniform(0, 1)` — no covariance between parameters assumed for v1. This is
the simplest defensible default that naturally spreads the population
across the range, which is what the parameter-variation robustness check
(`abm_data_generator.md` §16) needs to correlate parameter value against
outcome. Revisit if v1 results suggest specific parameters need a
different shape (e.g. skewed, bimodal) to produce meaningful variation.

**Baseline agent** (§16 "baseline" check — run once, deterministically,
before the stochastic population): all 5 parameters at the midpoint,
`0.5`. Sanity-checks that a "neutral" agent produces plausible behavior
before trusting the sampled population's variation.

## Population size

Two different scales, don't conflate them:

- **Full eventual H1 comparison** (condition-comparison check,
  `abm_data_generator.md` §16 — `unguided` availability is an external
  dependency on the target application, tracked outside this document):
  **30 agents per condition (60 total)**, each independently
  sampled per the distribution above. Not a statistically powered sample
  size — this project explicitly disclaims rigorous causal conclusions
  (`abm_data_generator.md` §4) — just enough repetition to see whether a
  pattern holds, per the spirit of §16.
- **Initial small-scale pilot** (mechanism validation, not H1 testing):
  **5-10 agents, `guided` only** (the only condition available today) plus
  the 1 baseline agent. Purpose is confirming the harness produces real,
  sensible, varied traces end-to-end — not testing the hypothesis.

## Application version / reproducibility

Record the target deployment's identifier (commit SHA or deployment URL,
whichever the harness's target environment exposes) as part of each run's
own metadata at execution time — not fixed in this document, since it
changes every run and isn't an experiment-design decision.

## Execution configuration

- Timeout: 10 minutes per agent (`abm_data_generator.md` §3).
- One synthetic account/company per agent, never reused across runs
  (policy already decided — see AGENTS.md, "Decisions settled for the
  ABM").
- `run_id`: one per execution batch; the initial pilot and the eventual
  full comparison are different runs, same `experiment_id`.

## Open questions (not blocking the initial pilot, revisit before the full comparison)

- Is `Uniform(0,1)` actually the right sampling shape, or should v2 use
  something else once pilot data exists to look at?
- Should parameters covary (e.g. is a highly exploratory agent also
  plausibly slower / higher time_cost). v1 assumes independence.
- **Future experiment, not this one**: does a naive agent starting from
  the application's general hub (rather than dropped directly into
  Gestão de Entidades) discover the right product area at all? A
  genuinely different research question (product information-architecture
  discoverability, not the Guided/Unguided journey comparison) — fits
  `abm_data_generator.md` §18 ("additional Matriz journeys") as a future
  candidate, not a variant of this one.
