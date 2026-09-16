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

## agent_parameters — the 6 parameters, their range, and how they're sampled

All 6 parameters from `abm_data_generator.md` §6, normalized to **[0, 1]**
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
| `commitment` | persistence of the agent's current goal (§8, "Goal state" below) — resistance to dropping it before it is satisfied | higher → more likely to finish what it started before moving on to something else |

**Sampling, per agent, independently per parameter:**
`Uniform(0, 1)` — no covariance between parameters assumed for v1, kept
for v2's new `commitment` parameter too. This is the simplest defensible
default that naturally spreads the population across the range, which is
what the parameter-variation robustness check (`abm_data_generator.md`
§16) needs to correlate parameter value against outcome. Revisit if
results suggest specific parameters need a different shape (e.g. skewed,
bimodal) to produce meaningful variation.

**Baseline agent** (§16 "baseline" check — run once, deterministically,
before the stochastic population): all 6 parameters at the midpoint,
`0.5`. Sanity-checks that a "neutral" agent produces plausible behavior
before trusting the sampled population's variation.

## Goal state (v2 decision model)

Extends the decision model described conceptually in
`abm_data_generator.md` §8 — this section fixes the concrete mechanism
for this experiment; the general model stays generic there.

**Goal kinds** (at most one active at a time):

| Kind | Trigger | Scope (which candidates count as "coherent" with it) |
|---|---|---|
| `dialog` | a modal/dialog becomes the focus of perception | candidates inside that dialog that carry a progress signal (an empty required field, or the submit control once the visible required fields are filled) — the same rule as `area`, applied to the dialog instead of the screen |
| `area` | the agent arrives at a screen it has not visited yet this run | candidates on the current screen that already carry a progress signal (primary-styled, or an empty required field) |

A link whose target is the screen the agent is already on never carries a
progress signal, whatever it looks like — a highlighted "you are here"
navigation item is a common UI convention, and following it changes
nothing. This is a rule about URLs, not about any specific application; it
matters because such an item is often the only filled/primary-styled
control on an otherwise empty screen.

`dialog` outranks `area`: if a dialog opens while an `area` goal is
active, the `area` goal ends immediately (superseded, not resumed later
if the dialog closes) and a `dialog` goal starts instead. Only one dialog
can be open at a time (perception already scopes to the topmost one), so
no further priority rule is needed.

**Lifecycle**, evaluated once per step, in this order:

1. If a `dialog` goal is active and no dialog is open any more (it was
   submitted, or closed by any other means), the goal ends now — before
   anything else is evaluated this step, so a screen reached by that
   submit can start an `area` goal in the same step.
2. If no goal is active, check the triggers above (in priority order) and
   start one if either fires. A goal that starts this step is fully
   active this step (`goal_age = 0`) — it does not wait a step to take
   effect.
3. If a goal is active, first roll its survival for this step: it ends
   ("dropped") with probability `GOAL_DROP_BASE × (1 − commitment)` —
   this is the "probability of abandoning the goal per step" that
   `commitment` governs. A dropped goal produces no pull this step; the
   agent decides exactly as it would with no goal at all.
4. A goal that survives step 3 pulls the softmax toward its coherent
   candidates and resists incoherent ones (see "Utility mechanics"
   below), then:
   - ends as **satisfied** if the step's chosen action produces progress
     within its scope (a submit inside a `dialog` goal's dialog; any
     progress-signal-bearing action inside an `area` goal's screen);
   - otherwise ends as **expired** once its age reaches a fixed ceiling
     (`GOAL_MAX_AGE` steps), regardless of `commitment` — the ceiling
     exists so a goal can never lock an agent in indefinitely, however
     committed it is;
   - otherwise persists, `goal_age` incremented by one for next step.

**Utility mechanics**, applied only while a goal is active and survives
step 2 above:

- **Pull**: every coherent candidate's click/type/navigate utility gains
  `commitment × GOAL_PULL_WEIGHT`, added the same way the existing
  `goal_seeking × progressSignal` term is — before the layer-1 `caution`
  multiplier (see below) is applied.
- **Distraction resistance**: `explore` utility on candidates outside the
  goal's scope, and (for an `area` goal only) `navigate` utility on
  candidates outside its scope, is scaled by
  `(1 − commitment × DISTRACTION_DAMPING)`. A
  `dialog` goal needs no separate distraction term — leaving an open
  dialog is already discouraged by the existing
  `dismissWhileIncompleteFactor` heuristic; adding a second discount for
  the same behavior would double-count it.

`GOAL_PULL_WEIGHT`, `DISTRACTION_DAMPING`, `GOAL_DROP_BASE` and
`GOAL_MAX_AGE` are constants to calibrate empirically once the mechanism
is implemented — no principled starting value yet. Follow the project's
existing pattern (a conservative default, refined by replicated
comparison against the baseline this experiment already fixed).

**Layer-1 heuristics carry over unchanged**: `revisitDirectFactor`,
`screenRevisitExploreFactor`, `destructiveFactor` and
`dismissWhileIncompleteFactor` (all currently defaulted off) keep their
existing meaning and defaults in v2 — the goal mechanism is additive to
them, not a replacement.

**`decision_signals` vocabulary** for this mechanism — diagnostic only,
`required: false`, does not change the contract:

| Signal | Meaning |
|---|---|
| `goal` | code for the currently active goal kind: `0` = none, `1` = `dialog`, `2` = `area` |
| `goal_age` | steps the current goal has persisted; `0` on the step it started, or on a step where it was dropped or never active |
| `goal_pull` | the actual pull value added to the chosen option's utility this step by the mechanism above; `0` when no goal is active, the chosen option wasn't in its scope, or the goal was dropped this step |

**Revision (2026-09-15)**: the first two replicated runs of this
mechanism were measured while the perception layer's primary-styled
detection was silently returning false for every element on the target (a
CSS color-space serialization issue, fixed in the harness) — so the `area`
scope above had nothing to pull toward and the mechanism degenerated into
a blanket discount on navigation. The three refinements above
(progress-bearing scope for `dialog`, `dialog` ending when its dialog
closes, self-links carrying no progress) come from reading those runs'
traces: the goal was pulling toward close/cancel controls and
already-filled fields, lingering after its dialog had closed and thereby
blocking the next `area` goal, and — once detection works — the current
screen's own navigation item would have been the only "progress" on an
empty screen.

## Action outcome

Found necessary in 2026-09-16, reading traces from the runs above: none of
the perception, goal, or utility machinery above knows whether an action
actually *worked*. A submit that silently fails (invalid input rejected by
the target, a required selection never made) is indistinguishable, to
everything above, from one that succeeded — the same control stays the
highest-utility option next step, and stays that way indefinitely. Agents
were observed clicking one submit control 100+ times in a single run.

**Observable state**, for this purpose: the current screen (pathname),
whether a dialog is open, and the ordered set of perceived
controls with their text and filled state. Two states are "the same" if
all of that matches.

**No-effect detection**: after a `click` or `navigate` action, if the next
step's observable state is unchanged, that action produced no effect —
recorded as a per-control count that keeps incrementing across attempts on
the same control. The control is identified by its container (inside the
open dialog, or on the page) plus its visible text — not by its position
among the perceived controls, which shifts whenever something appears or
disappears earlier in the same container. `type` and `explore` landing on
a form field are excluded by construction, not by a special case: filling
a field changes its filled state, so the observable state already differs.

**Memory scope** (revised 2026-09-16 — the first version cleared every
count on *any* change in observable state, and the traces showed why that
is too eager: an agent alternating submit → type in a field → submit had
its memory wiped by every `type`, and an agent that closed the dialog and
reopened it started from zero each time; both loops ran until the session
timed out). The memory of "this doesn't work" now lives as long as the
container that produced it:

- **Dialog-level memory** (controls inside an open dialog) is kept while
  that dialog stays open — filling a field next to the button, or a
  control appearing or disappearing inside the dialog, is not evidence
  that the button now works. It is dropped when the dialog closes.
- **Closing a dialog in frustration carries the memory out.** If the agent
  itself closed the dialog with a close/cancel-worded control after
  failing in it, the sum of the failures inside is added to the count of
  the control that *opened* that dialog: "I tried that form n times and
  gave up" — reopening it stops looking like progress, at the same
  per-attempt decay as any other unresponsive control. A dialog that
  closed any other way (submit accepted, or nothing had failed in it)
  takes its memory with it.
- **Page-level memory** (controls outside any dialog, including what was
  carried out of a dialog) is kept while the pathname holds, and dropped
  when the screen changes: new screen, new forms, nothing learned here
  carries over.

This is deliberately about **state, not text** — perceiving an error
message (`[role="alert"]`, `aria-invalid`, or a visual heuristic for
freshly-appeared red text) was considered and set aside: it would require
either an ARIA convention the target application may not follow, or a
heuristic arbitrary enough to defeat the point of a generic harness. A
human who presses a button and sees literally nothing happen stops
pressing it without ever having read why — that is the prior this
mechanism encodes, nothing more.

**Effects on utility**, both scaled by the repeated-attempt count on the
specific control in question:

- A control's progress signal and attention both decay by
  `NO_EFFECT_DECAY` per accumulated no-effect attempt on it — it stops
  looking like progress and stops standing out, at the same rate.
- **Frustration**, a per-container (not per-control) signal:
  `min(1, (sum of the no-effect counts in the current container) /
  FRUSTRATION_STEPS)` — the open dialog's counts when a dialog is open,
  the page's otherwise (including what was carried out of a dialog the
  agent gave up on). A human stuck in a form doesn't credit one specific
  click for the frustration; anything stuck *in that form* counts — but
  what went nowhere on the page behind it does not pre-load the form
  (the first scoping, run-wide, did exactly that once memory started
  persisting: forms were dismissed the moment they opened). It adds
  directly to the utility of a close/cancel-worded control inside the
  open dialog (letting frustration eventually overcome the existing
  `dismissWhileIncompleteFactor` resistance to leaving an incomplete form
  — the two forces are meant to oppose each other and one should be able
  to win), and to abandon utility, in the same additive form the
  time-pressure term already uses.

`NO_EFFECT_DECAY`, `FRUSTRATION_STEPS`, `FRUSTRATION_DISMISS_WEIGHT` and
`ABANDON_FRUSTRATION_WEIGHT` are constants to calibrate empirically, same
status as the goal-state constants above — conservative starting values,
no principled derivation yet.

**`decision_signals` vocabulary** for this mechanism — diagnostic only,
`required: false`, does not change the contract:

| Signal | Meaning |
|---|---|
| `no_effect` | the chosen action's target's current no-effect count (0 if the target has never failed to change state, or the action has no target) |
| `frustration` | the current container's frustration value this step, in `[0, 1]` |

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
- **v2 goal mechanism**: should `goal_pull` decay over `goal_age` instead
  of staying constant for the goal's whole life? Deferred — simplest
  version first, revisit only if replicated runs show a need for it.
- **v2 goal mechanism**: should an `area` goal resume if a superseding
  `dialog` goal closes before expiring, instead of ending permanently?
  Deferred for the same reason.
