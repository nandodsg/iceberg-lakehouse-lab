# ABM Data Generator

**Status:** Design document --- v0.1\
**Role:** Data-generation component of the Iceberg Lakehouse Lab

## 1. Purpose

The ABM Data Generator creates controlled, synthetic behavioral data by
executing agents against the **real Matriz de Senioridade application in
DEV/STG** through E2E automation.

Its primary purpose is to provide realistic behavioral data for the
**Iceberg Lakehouse Lab**.

The ABM is deliberately subordinate to the Lakehouse Lab. It is not
currently an independent product or research project.

> **The ABM is a vassal of the Iceberg Lakehouse Lab.**

It may become an independent portfolio repository in the future if its
standalone value justifies the additional maintenance.

## 2. Relationship with the Iceberg Lakehouse Lab

``` text
             ABM Data Generator
                     │
              Claude Code / E2E
                     │
                     ↓
              Matriz DEV / STG
                 │          │
                 ↓          ↓
                GA4      Supabase
                 │          │
                 ↓          ↓
              BigQuery    PostgreSQL
                 │          │
                 └────┬─────┘
                      ↓
              Iceberg Lakehouse Lab
```

The ABM does not own the Lakehouse architecture.

The Lakehouse Lab owns:

-   ingestion;
-   Iceberg;
-   dbt;
-   Airflow;
-   Databricks;
-   Snowflake;
-   quality;
-   governance;
-   analytical modeling.

The ABM owns the generation of behavioral activity and the metadata
necessary to interpret those generated observations.

## 3. Research question

> **In a sequential entity-registration journey, does guided navigation
> --- where completing one step automatically redirects the user to the
> next --- increase the probability of completing the journey compared
> with unguided navigation?**

The initial journey is:

``` text
Create Company
      ↓
Create Team
      ↓
Create Member
```

A successful journey is:

> A company has at least one team with at least one member.

The initial completion window is **10 minutes**.

## 4. Experimental hypothesis

> **H1:** Agents exposed to the Guided flow have a higher probability of
> completing Company → Team → Member within 10 minutes than agents
> exposed to the Unguided flow.

The experiment is intended to explore the interaction between:

-   interface characteristics;
-   agent behavioral parameters;
-   navigation rules;
-   observed outcomes.

It is not intended to establish scientifically rigorous causal
conclusions about real human users.

## 5. Experimental conditions

### Guided

After completing a step, the application automatically redirects the
agent to the next logical step.

``` text
Company
   ↓ automatic redirect
Team
   ↓ automatic redirect
Member
```

### Unguided

After completing a step, the application does not automatically redirect
the agent. The agent decides what to do next.

``` text
Company
   ↓
agent chooses next action

Team
   ↓
agent chooses next action

Member
```

The intended independent variable is therefore:

> **Automatic redirection to the next step.**

The underlying application is the real Matriz application running in
DEV/STG.

## 6. Agent model

Agents are not predefined as personas.

Instead, agents are characterized by behavioral parameters. Different
combinations of parameters may produce emergent behavioral patterns that
could resemble different user types.

The initial model includes:

### Goal seeking

-   reward for finding the correct CTA quickly;
-   reward for correctly completing the current stage.

### Exploration

-   reward or penalty associated with exploring alternative elements;
-   propensity to explore instead of immediately progressing.

### Visual sensitivity

A single parameter representing sensitivity to visual complexity.

The agent reacts to characteristics such as:

-   number/density of elements;
-   occupied versus empty screen area;
-   contrast;
-   visual prominence.

### Time

-   cost associated with elapsed time;
-   potential pressure from approaching the 10-minute limit.

### Abandonment

-   propensity to abandon when perceived progress or expected reward
    becomes insufficient.

### Commitment

-   persistence of the agent's current intent across consecutive steps;
-   resistance to switching away from what it started doing before that
    intent is satisfied or clearly abandoned.

Introduced together with the persistent-goal mechanism (§8) — earlier
versions of this model re-decided everything from first principles at
every step, with no memory of what the agent had been doing.

These parameters are hypotheses for the initial model and may be changed
through experimentation.

## 7. Perception model

The agent can perceive the actual interface presented by the
application.

It can perceive interface characteristics such as:

-   text;
-   position;
-   size;
-   color;
-   contrast;
-   visual prominence;
-   interactive state;
-   other visible elements.

The agent is **not told which element is the correct CTA**.

For example, the application may visually distinguish the intended
action with a black button and hover behavior. The agent can perceive
those characteristics, but its behavioral parameters determine how
strongly they affect attention.

The conceptual mechanism is:

``` text
Interface characteristics
          ↓
    perceived salience
          ↓
         attention
          ↓
      decision process
          ↓
          action
```

Visual salience therefore does not directly determine the click. It
influences the agent's attention.

## 8. Decision model

At each interaction point, the agent:

1.  observes the available interface;
2.  evaluates perceived elements;
3.  checks whether it is currently pursuing a goal carried over from a
    previous step, and whether a new one should start or supersede it;
4.  applies its behavioral parameters — including how strongly its
    current goal, if any, pulls attention toward coherent elements;
5.  selects an action;
6.  receives the resulting environmental feedback;
7.  updates its state, including whether the current goal was satisfied,
    dropped, or should persist;
8.  continues, explores or abandons.

Earlier versions of this model made every decision independently, with no
memory of what the agent had been doing. Real users carry short-lived
intent across several steps — "I opened this form, I'll finish it"; "I
navigated here, I'll do something in this area" — and re-deciding from
scratch at every step cannot reproduce that, however the other parameters
are tuned.

From this version onward, the agent may hold a **current goal**: a
short-lived commitment to a coherent set of elements, established by a
structural trigger — a modal/form becoming the focus of attention, or
arriving at a screen not visited yet this run — never a specific route or
element name, consistent with the rule below that the agent is not told
which action is correct. A goal persists for a bounded number of steps,
or until it is satisfied (progress happens within its scope) or dropped
(governed by the agent's `commitment` parameter, §6) — whichever comes
first. While a goal is active it increases the perceived value of
coherent elements and reduces the pull of unrelated ones, without ever
forcing a specific action. Concrete parameter ranges, sampling and the
diagnostic signals this mechanism produces are experiment-specific — see
`abm/experiments/guided-vs-unguided/definition.md`.

Step 6 ("receives the resulting environmental feedback") includes noticing
when an action changed nothing observable at all — a control that keeps
failing silently progressively loses credibility as "the way forward" and
raises a general frustration that can push the agent to abandon the form
or the run, the same way a human stops pressing a button that never
responds, without ever reading why. That memory lasts as long as the
place that produced it (the open form, the current screen) — filling
another field does not make the button credible again, and giving up on
a form makes the way back into it less attractive too.

The model should avoid hard-coding the expected journey.

In particular, the agent should not simply contain a rule equivalent to:

> "Click the black Cadastrar button."

The objective is to allow the interface and behavioral parameters to
produce the observed action.

## 9. Environment

The environment is the **real Matriz application in DEV/STG**.

The ABM does not reproduce the application.

The environment therefore provides, naturally:

-   real screens;
-   real navigation;
-   real forms;
-   real validation;
-   real application state;
-   real entity creation;
-   real Supabase records;
-   real GA4 events.

DEV/STG are already isolated from production and contain synthetic
accounts and data.

## 10. Execution

Agents are executed through **Claude Code and E2E automation**.

The execution layer is responsible for:

-   creating/initializing the agent configuration;
-   authenticating with the appropriate synthetic account;
-   navigating the application;
-   observing the interface;
-   selecting actions;
-   respecting the experiment condition;
-   stopping when the journey succeeds, the agent abandons, or 10
    minutes are reached;
-   recording experiment metadata.

The implementation should use the application's existing E2E
capabilities wherever practical rather than creating a parallel
application.

## 11. Generated behavioral data

The execution should produce sufficient metadata to connect each
observed behavior with its experimental context.

Conceptually:

``` text
experiment_id
run_id
agent_id
agent_parameters
condition
session_id
timestamp
screen
element
action
attention
reward
penalty
elapsed_time
journey_stage
journey_completed
```

The exact event schema is to be defined before implementation and
represented by the ABM output data contract.

The generated dataset should preserve the ability to answer:

-   Which experiment produced this event?
-   Which agent produced it?
-   Which behavioral parameters did that agent have?
-   Which condition was active?
-   What screen/action occurred?
-   How long had the journey been running?
-   Did the agent ultimately complete the journey?

## 12. System-generated data

The ABM itself is not the only source of observations.

The real application should generate its normal system data:

``` text
Agent interaction
       │
       ├──→ GA4 events → BigQuery
       │
       └──→ entity mutations → Supabase
```

The Iceberg Lab will subsequently combine these sources.

This distinction is important:

-   **ABM metadata** explains how the synthetic agent was configured.
-   **GA4** records application interaction behavior.
-   **Supabase** records resulting application state.

## 13. Data generation principle

The objective is not to fabricate a dataset directly inside the
Lakehouse.

Instead:

> **Generate behavior through the real application and let the
> application's real data systems record it.**

This gives the Lakehouse Lab a realistic multi-source data-generation
scenario.

## 14. Metrics

### Primary

**Journey completion rate**

Percentage of agents that achieve:

`Company ≥ 1` + `Team ≥ 1` + `Member ≥ 1`

within 10 minutes.

### Secondary

-   time to completion;
-   abandonment rate;
-   number of actions;
-   number of deviations from the expected path;
-   time spent per stage;
-   action sequence;
-   exploration behavior;
-   estimated attention/reward trajectory.

## 15. Experiment execution

The initial experiment should vary:

``` text
Condition
├── Guided
└── Unguided
```

while holding the population of behavioral parameters constant between
conditions.

Subsequent experiments may vary individual parameters to understand
sensitivity.

A useful structure is:

``` text
Experiment
 ├── condition
 ├── population definition
 ├── parameter distributions
 ├── application version
 └── execution configuration
```

Every run should be identifiable and reproducible as far as the E2E
environment permits.

## 16. Validation and robustness

The project does not seek formal scientific validation.

Nevertheless, the model should avoid conclusions that are artifacts of a
single arbitrary configuration.

Initial checks:

### Baseline

Run agents with neutral/default parameter values.

### Parameter variation

Change one or more behavioral parameters and observe whether behavior
changes in the expected direction.

### Repetition

Run multiple agents per condition.

### Condition comparison

Compare Guided and Unguided under equivalent parameter populations.

### Robustness

Identify whether the observed difference persists across reasonable
parameter configurations.

## 17. Scope constraints

The ABM must remain intentionally small.

Do not introduce additional complexity unless it serves the Lakehouse
Lab or materially improves the experiment.

Initially avoid:

-   reproducing the application;
-   building an independent simulation UI;
-   building a general-purpose ABM framework;
-   sophisticated LLM agent architectures;
-   large-scale multi-agent social interaction;
-   unnecessary orchestration;
-   independent data platforms.

The initial goal is simply:

> **Generate useful, traceable behavioral data through the real Matriz
> application.**

## 18. Future possibilities

If the component demonstrates value, future versions could explore:

-   richer behavioral parameter distributions;
-   LLM-based decision-making;
-   additional Matriz journeys;
-   more sophisticated attention models;
-   adaptive agents;
-   larger synthetic populations;
-   reusable synthetic behavioral datasets;
-   standalone portfolio repository.

These are explicitly future possibilities, not current requirements.

## 19. Graduation criteria for the ABM component

The ABM has succeeded for the current Lab when it can:

1.  execute agents against Matriz DEV/STG;
2.  run Guided and Unguided conditions;
3.  generate repeatable behavioral activity;
4.  produce identifiable experiment metadata;
5.  generate real GA4 and Supabase activity;
6.  provide data suitable for ingestion into the Iceberg Lab;
7.  remain simple enough that it does not become the main project.

The ABM should only become an independent repository if its standalone
value becomes clear.

## 20. Relationship to contracts

The ABM generates behavioral data that will be consumed by the Lakehouse
Lab.

The Lab owns the **ABM behavioral output contract**.

The Matriz repository independently owns the contracts governing which
application data may be exported.

The ABM must not bypass those export boundaries.

``` text
Matriz
 ├── Safe Export Contracts
 │
 └── DEV/STG application
          ↑
          │ E2E
          │
       ABM Agent
          │
          ↓
   behavioral metadata
          │
          ↓
     Iceberg Lab
```

## 21. Decision rule

Whenever a proposed ABM enhancement is considered, ask:

> **Does this materially improve the data generation or learning
> objectives of the Iceberg Lakehouse Lab?**

If not, defer it.

The project deliberately favors:

> **useful data + reproducibility + learning value**

over:

> **ABM sophistication for its own sake.**
