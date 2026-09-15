import type { DecisionContext, DecisionResult, GoalState, PerceivedElement, Action } from "./types.js";
import { weightedPick } from "./rng.js";

/**
 * Explicit, auditable decision policy — perceived UI features × per-agent
 * behavioral parameters → softmax over candidate actions. This is the
 * mechanism itself: no LLM judgment, no knowledge of which element is
 * "correct" (abm_data_generator.md §8). Everything here is generic across
 * any application; nothing here has ever seen matriz-senioridade's code.
 *
 * See abm/experiments/guided-vs-unguided/definition.md for what the 5
 * agent_parameters mean and how they're distributed — this file only
 * implements the mechanism, not this experiment's specific values.
 */

// Softmax temperature — open question (not yet tuned against real data,
// see the experiment definition's "Open questions"): higher = more
// uniform/random choice, lower = more deterministic toward the highest
// utility. 1.0 is a neutral starting point.
// Calibrated down from 1.0 after the debug run of 2026-09-15: at 1.0 a
// goal_seeking=0.91 agent still picked the single primary-styled control
// only ~10% of the time against ~30 low-utility alternatives (the softmax
// over "one option per element" dilutes any single strong preference).
const TEMPERATURE = 0.35;

// Time pressure is a threshold ramp, not linear from the start — the
// agent shouldn't feel time pressure at second 10 of a 600-second run.
// Starts ramping at 70% of the timeout, per abm_data_generator.md §3
// ("pressure from approaching the 10-minute limit").
const PRESSURE_RAMP_START_FRACTION = 0.7;

// Baseline utility for "wait" — small and constant, only wins the
// softmax when every other option's utility is near zero too.
const WAIT_BASE_UTILITY = 0.05;

// Abandonment: a negative base so that giving up is RARE when nothing
// pushes toward it, scaled up by the agent's propensity and by time
// pressure. The first pilot (2026-09-15) used `propensity × pressure`,
// which is exactly 0 before the pressure ramp — i.e. neutral utility,
// equal weight to any other option in the softmax — so every agent had a
// fixed ~5-10% chance per step of quitting regardless of its parameter,
// and the whole batch abandoned within 12 s. With these constants, at
// propensity 0.5 and no pressure each abandon variant weighs e^-1.5
// (≈0.22) against ≈e^0.3..1.6 per visible element.
const ABANDON_BASE_UTILITY = -2.5;
const ABANDON_PROPENSITY_WEIGHT = 2.0;
const ABANDON_PRESSURE_WEIGHT = 3.0;

// Generic form affordance (UX prior, not app knowledge): an empty required
// field is "progress waiting to happen", and a submit control is progress
// only once the visible required fields are filled — humans fill the
// form before pressing the button, and the button does nothing otherwise.
const REQUIRED_FIELD_PROGRESS = 0.8;

// A field that already has a value draws far less attention than an empty
// one — piloto-02 (2026-09-15) had an agent re-type the same field 8 times.
const FILLED_FIELD_ATTENTION_FACTOR = 1.0;

// Calibration rounds 4-5 (2026-09-15) tried four generic UX priors (below,
// all defaulting to 1.0 = off). Replicated comparison — same population,
// 3 runs per policy — showed the "round 3" policy (all off) reaches
// company/team MORE often (3.33 vs 1.67 of 6; team only ever with it) and
// keeps goal-seeking agents in the area under study more (59% vs 89% of
// steps outside); what the priors buy is cosmetic (less A→B→A
// ping-pong, 1.3 vs 3.3). Defaults therefore stay at the round-3 policy;
// the priors remain available as `policy` overrides in the run config
// (see PolicyOverrides). The structural fix for ping-pong is a persistent
// goal, not a revisit penalty — next epic.
// The four priors, none of them knowledge of any specific route:
// - a control already used this run is much less attractive to use
//   again directly (humans rarely re-click the same link back and forth;
//   piloto-03 agents ping-ponged between the same 3 navigation links for
//   the first 20-30 s);
const REVISIT_DIRECT_FACTOR = 1.0;
// - a screen already seen is less interesting to explore (memory of
//   "I've been here"), decaying with each return. Round 5 (2026-09-15)
//   set this to 1.0 (off): with the same population, 0.5 pushed agents
//   OUT of the area under study (the entry screen is always "already
//   seen") — outside share 64% → 89%, reached-team 2/6 → 0/6. Kept as a
//   knob, documented as harmful at 0.5.
const SCREEN_REVISIT_EXPLORE_FACTOR = 1.0;
// - destructive vocabulary makes a human hesitate (piloto-03 agents
//   wandered into account-deletion pages);
const DESTRUCTIVE_TEXT_PATTERN = /\b(delete|remove|excluir|remover|apagar|eliminar|destroy)\b/i;
const DESTRUCTIVE_FACTOR = 1.0;
// - inside an open dialog with required fields still empty, the controls
//   that close/cancel it lose pull: whoever opened a form tends to try to
//   finish it (a minimal form of intent persistence). Round 5: 0.2 → 0.5 —
//   at 0.2 an agent that opened the form by accident almost always
//   finished it, which erased goal_seeking's role (a 0.18 agent created a
//   company, a 0.78 one didn't).
const DISMISS_TEXT_PATTERN = /\b(close|cancel|fechar|cancelar|voltar|back)\b|^[×x✕]$/i;
const DISMISS_WHILE_INCOMPLETE_FACTOR = 1.0;

// Persistent-goal mechanism (guided-vs-unguided/definition.md, "Goal
// state"): the structural fix the round 4-5 heuristics above couldn't be —
// a real short-lived intention that persists across steps instead of a
// per-step discount. None of these four constants have been calibrated
// against real runs yet (that's the next epic item); values below are
// conservative starting guesses, same role TEMPERATURE etc. played before
// their first pilot.
const GOAL_PULL_WEIGHT = 0.5;
const DISTRACTION_DAMPING = 0.5;
const GOAL_DROP_BASE = 0.15;
const GOAL_MAX_AGE = 6;

// Common sign-out vocabulary across languages — a generic UI convention,
// not knowledge specific to any one application. A control that reads
// like sign-out is only ever offered as `abandon_logout`, never as
// click/explore: pressing it IS leaving, whatever the agent "meant".
export const LOGOUT_TEXT_PATTERN = /\b(log ?out|sign ?out|sair|encerrar sess[ãa]o)\b/i;

interface Option {
  action: Action;
  target?: PerceivedElement;
  utility: number;
  signals: Record<string, number>;
  /** Pull this option received from the active goal this step (0 if none/not coherent). */
  goalPull?: number;
  /** Whether this option's target is inside the active goal's scope (see GoalState). */
  coherent?: boolean;
}

export function decide(ctx: DecisionContext): DecisionResult {
  const { candidates, params, elapsedSeconds, timeoutSeconds, screenVisits } = ctx;
  const pol = {
    temperature: ctx.policy?.temperature ?? TEMPERATURE,
    filledFieldAttentionFactor: ctx.policy?.filledFieldAttentionFactor ?? FILLED_FIELD_ATTENTION_FACTOR,
    revisitDirectFactor: ctx.policy?.revisitDirectFactor ?? REVISIT_DIRECT_FACTOR,
    screenRevisitExploreFactor: ctx.policy?.screenRevisitExploreFactor ?? SCREEN_REVISIT_EXPLORE_FACTOR,
    destructiveFactor: ctx.policy?.destructiveFactor ?? DESTRUCTIVE_FACTOR,
    dismissWhileIncompleteFactor: ctx.policy?.dismissWhileIncompleteFactor ?? DISMISS_WHILE_INCOMPLETE_FACTOR,
    goalPullWeight: ctx.policy?.goalPullWeight ?? GOAL_PULL_WEIGHT,
    distractionDamping: ctx.policy?.distractionDamping ?? DISTRACTION_DAMPING,
    goalDropBase: ctx.policy?.goalDropBase ?? GOAL_DROP_BASE,
    goalMaxAge: ctx.policy?.goalMaxAge ?? GOAL_MAX_AGE,
  };
  const goalSeeking = params.goal_seeking ?? 0.5;
  const exploration = params.exploration ?? 0.5;
  const visualSensitivity = params.visual_sensitivity ?? 0.5;
  const abandonmentPropensity = params.abandonment_propensity ?? 0.5;
  const commitment = params.commitment ?? 0.5;

  const timePressure = computeTimePressure(elapsedSeconds, timeoutSeconds);

  // Goal transition, evaluated before any utility is computed — priority
  // order matches the experiment definition: a dialog opening always wins
  // (starting fresh or superseding an `area` goal), otherwise arriving at
  // an unseen screen can start an `area` goal, otherwise a carried-over
  // goal is subject to its per-step survival roll. A goal that starts
  // this step is fully active this step — it never rolls for survival on
  // its own creation step.
  const dialogOpen = candidates.some((c) => c.inDialog);
  let goal: GoalState = ctx.goal ?? null;
  if (dialogOpen && goal?.kind !== "dialog") {
    goal = { kind: "dialog", age: 0 };
  } else if (!goal && !dialogOpen && ctx.screenChanged && screenVisits === 0) {
    goal = { kind: "area", age: 0 };
  } else if (goal) {
    const dropProb = pol.goalDropBase * (1 - commitment);
    if (ctx.rng() < dropProb) goal = null;
  }
  const goalActive = goal !== null;

  const options: Option[] = [];

  const requiredEmpty = candidates.filter((c) => c.isFormField && c.required && !c.filled).length;
  const logoutTarget = candidates.find((c) => LOGOUT_TEXT_PATTERN.test(c.text));
  // Curiosity is spread over what there is to explore, not summed over it:
  // "explore something" should weigh about the same on a page with 3
  // unvisited controls as on one with 30.
  const unvisitedCount = Math.max(1, candidates.filter((c) => !c.visited).length);
  const exploreNormalization = Math.log(unvisitedCount) * pol.temperature;

  for (const el of candidates) {
    if (el === logoutTarget) continue;
    const salience = computeSalience(el);
    const attention =
      salience * visualSensitivity * (el.isFormField && el.filled ? pol.filledFieldAttentionFactor : 1);
    let progressSignal = el.isPrimaryStyled ? 1 : 0;
    if (el.isFormField && el.required && !el.filled) progressSignal = Math.max(progressSignal, REQUIRED_FIELD_PROGRESS);
    if (el.isSubmit && requiredEmpty > 0) progressSignal = 0;
    // Re-filling an already filled field is not progress.
    if (el.isFormField && el.filled) progressSignal = 0;

    // Generic hesitation/commitment priors (see constants above).
    let caution = 1;
    if (DESTRUCTIVE_TEXT_PATTERN.test(el.text)) caution *= pol.destructiveFactor;
    if (el.inDialog && requiredEmpty > 0 && !el.isFormField && !el.isSubmit && DISMISS_TEXT_PATTERN.test(el.text)) {
      caution *= pol.dismissWhileIncompleteFactor;
    }
    if (el.visited && !el.isFormField) caution *= pol.revisitDirectFactor;

    // Coherence with the active goal, if any — see GoalState/definition.md
    // "Goal state". `dialog`: anything perceived inside that dialog.
    // `area`: anything that already carries a progress signal (reuses the
    // same test as goal_seeking's pull above, not a new concept).
    const coherent = goalActive && (goal!.kind === "dialog" ? el.inDialog : progressSignal > 0);
    const goalPull = coherent ? commitment * pol.goalPullWeight : 0;

    // goal_seeking-directed pull toward this element, now plus the active
    // goal's pull (§ above) when this element is coherent with it.
    let clickUtility = (attention + goalSeeking * progressSignal + goalPull) * caution;
    const directAction = classifyDirectAction(el);
    // Distraction resistance is `area`-only and navigate-only: leaving an
    // open dialog is already discouraged by dismissWhileIncompleteFactor
    // above, so a second discount there would double-count the same thing.
    if (goalActive && goal!.kind === "area" && directAction === "navigate" && !coherent) {
      clickUtility *= Math.max(0, 1 - commitment * pol.distractionDamping);
    }
    options.push({
      action: directAction,
      target: el,
      utility: Math.max(clickUtility, 0),
      signals: { attention, reward: goalSeeking * progressSignal },
      goalPull,
      coherent,
    });

    // Curiosity pull toward this element, independent of whether it
    // looks like the "correct" action — much weaker once already
    // visited this run, and weaker on a screen already seen. Also
    // resisted while a goal is active and this element isn't coherent
    // with it, regardless of goal kind.
    const novelty = (el.visited ? 0.1 : 1) * Math.pow(pol.screenRevisitExploreFactor, screenVisits);
    let exploreUtility = exploration * novelty * caution;
    if (goalActive && !coherent) {
      exploreUtility *= Math.max(0, 1 - commitment * pol.distractionDamping);
    }
    options.push({
      action: "explore",
      target: el,
      utility: Math.max(exploreUtility, 0) - exploreNormalization,
      signals: { attention, reward: exploreUtility },
    });
  }

  // Abandonment: split between idle (went quiet) and logout (explicit
  // exit) — even weight for v1, open question in the experiment
  // definition whether they should differ.
  const abandonUtility =
    ABANDON_BASE_UTILITY +
    ABANDON_PROPENSITY_WEIGHT * abandonmentPropensity +
    ABANDON_PRESSURE_WEIGHT * abandonmentPropensity * timePressure;
  options.push({
    action: "abandon_idle",
    utility: abandonUtility,
    signals: { penalty: timePressure },
  });
  options.push({
    action: "abandon_logout",
    target: logoutTarget,
    utility: abandonUtility,
    signals: { penalty: timePressure },
  });

  options.push({
    action: "wait",
    utility: WAIT_BASE_UTILITY,
    signals: { penalty: timePressure },
  });

  const weights = options.map((o) => Math.exp(o.utility / pol.temperature));
  const chosen = weightedPick(ctx.rng, options, weights);

  // Goal outcome for next step: satisfied by the chosen action, expired
  // by its age ceiling, or persisting. A goal that was dropped or never
  // active above is simply not carried forward.
  let nextGoal: GoalState = null;
  if (goal) {
    const satisfied =
      !!chosen.coherent &&
      (goal.kind === "dialog" ? chosen.action === "click" && !!chosen.target?.isSubmit : true);
    if (!satisfied) {
      const nextAge = goal.age + 1;
      if (nextAge < pol.goalMaxAge) nextGoal = { kind: goal.kind, age: nextAge };
    }
  }

  return {
    action: chosen.action,
    target: chosen.target,
    decision_signals: {
      ...chosen.signals,
      time_pressure: timePressure,
      goal: goal ? (goal.kind === "dialog" ? 1 : 2) : 0,
      goal_age: goal?.age ?? 0,
      goal_pull: chosen.goalPull ?? 0,
    },
    nextGoal,
  };
}

/**
 * What executing the goal-directed pull toward this element actually
 * means, mechanically: fill a form field, follow a link, or click a
 * button/generic control. A labeling distinction on top of perception,
 * not a separate signal — see actuation.ts for what each does.
 */
function classifyDirectAction(el: PerceivedElement): Action {
  if (el.tag === "input" || el.tag === "textarea" || el.tag === "select") return "type";
  if (el.tag === "a" && el.href) return "navigate";
  return "click";
}

/**
 * Generic visual salience: bigger, more top-left (natural reading order
 * in LTR layouts), and filled/primary-styled elements are more salient.
 * Normalized roughly to [0, ~1.5] — not a probability, just a relative
 * weight consumed by the softmax.
 */
function computeSalience(el: PerceivedElement): number {
  let s = 0;
  const box = el.boundingBox;
  if (box) {
    const area = box.width * box.height;
    s += Math.min(area / 5000, 1); // size, capped
    const positionBias = Math.max(0, 1 - (box.x + box.y) / 1500); // top-left bias, floors at 0
    s += 0.5 * positionBias;
  }
  if (el.isPrimaryStyled) s += 0.5;
  return s;
}

/**
 * Threshold ramp: near-zero until PRESSURE_RAMP_START_FRACTION of the
 * timeout, then rises linearly to 1 at the timeout.
 */
function computeTimePressure(elapsedSeconds: number, timeoutSeconds: number): number {
  const rampStart = timeoutSeconds * PRESSURE_RAMP_START_FRACTION;
  if (elapsedSeconds <= rampStart) return 0;
  return Math.min((elapsedSeconds - rampStart) / (timeoutSeconds - rampStart), 1);
}
