# experiments/

ABM experiment definitions, run configs, and results for the Guided vs.
Unguided comparison (and any later experiments). See
[abm_data_generator.md](../abm_data_generator.md).

## Contents

- [`guided-vs-unguided/definition.md`](guided-vs-unguided/definition.md) —
  the first experiment: `experiment_id`, journey/condition vocabulary,
  the 5 `agent_parameters` and their sampling distribution, population
  size, execution config. Draft, not yet run.

## Design decisions settled so far (durable — see [AGENTS.md](../../AGENTS.md) for the full log; implementation-level specifics against Matriz live in private notes, not here — see AGENTS.md's confidentiality rule)

- The decision policy that drives each agent is an explicit, auditable
  stochastic model (perceived UI features × per-agent behavioral parameters
  → softmax over candidate actions, including explore/abandon), evaluated
  live at each step against the real observed app state — **not** an LLM
  deciding in character. Population (parameter distributions per condition)
  is precomputed once; per-agent action sequences are generated live, not
  pre-scripted end to end.
- Playwright is the intended perception+actuation harness — reading the
  real DOM/screenshot and executing the sampled action — not a
  decision-maker.
- Guided/Unguided is provided by matriz-senioridade's native A/B testing
  capability (planned on its roadmap), not a Lab-side hack.
- Experiment/population attribution is a single mechanism assigned once at
  login and propagated automatically downstream, joined into the app's own
  data via a shared identifier — no changes needed to individual events or
  to the entity schema.
- Policy: one synthetic account/company per ABM run, never reused —
  sidesteps the need for run-level tagging infrastructure on day one
  (synthetic accounts are cheap to provision).

Not yet implemented.
