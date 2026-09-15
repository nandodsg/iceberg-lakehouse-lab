import type { DecisionContext, DecisionResult, PerceivedElement, Action } from "./types.js";
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

// Calibration round 4 (2026-09-15, after watching piloto-03 videos) —
// four generic UX priors, none of them knowledge of any specific route:
// - a control already used this run is much less attractive to use
//   again directly (humans rarely re-click the same link back and forth;
//   piloto-03 agents ping-ponged between the same 3 navigation links for
//   the first 20-30 s);
const REVISIT_DIRECT_FACTOR = 0.3;
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
const DESTRUCTIVE_FACTOR = 0.3;
// - inside an open dialog with required fields still empty, the controls
//   that close/cancel it lose pull: whoever opened a form tends to try to
//   finish it (a minimal form of intent persistence). Round 5: 0.2 → 0.5 —
//   at 0.2 an agent that opened the form by accident almost always
//   finished it, which erased goal_seeking's role (a 0.18 agent created a
//   company, a 0.78 one didn't).
const DISMISS_TEXT_PATTERN = /\b(close|cancel|fechar|cancelar|voltar|back)\b|^[×x✕]$/i;
const DISMISS_WHILE_INCOMPLETE_FACTOR = 0.5;

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
}

export function decide(ctx: DecisionContext): DecisionResult {
  const { candidates, params, elapsedSeconds, timeoutSeconds, screenVisits } = ctx;
  const goalSeeking = params.goal_seeking ?? 0.5;
  const exploration = params.exploration ?? 0.5;
  const visualSensitivity = params.visual_sensitivity ?? 0.5;
  const abandonmentPropensity = params.abandonment_propensity ?? 0.5;

  const timePressure = computeTimePressure(elapsedSeconds, timeoutSeconds);

  const options: Option[] = [];

  const requiredEmpty = candidates.filter((c) => c.isFormField && c.required && !c.filled).length;
  const logoutTarget = candidates.find((c) => LOGOUT_TEXT_PATTERN.test(c.text));
  // Curiosity is spread over what there is to explore, not summed over it:
  // "explore something" should weigh about the same on a page with 3
  // unvisited controls as on one with 30.
  const unvisitedCount = Math.max(1, candidates.filter((c) => !c.visited).length);
  const exploreNormalization = Math.log(unvisitedCount) * TEMPERATURE;

  for (const el of candidates) {
    if (el === logoutTarget) continue;
    const salience = computeSalience(el);
    // A field that already has a value draws far less attention than an
    // empty one — piloto-02 (2026-09-15) had an agent re-type the same
    // field 8 times because visual salience alone doesn't know it's done.
    const attention = salience * visualSensitivity * (el.isFormField && el.filled ? 0.25 : 1);
    let progressSignal = el.isPrimaryStyled ? 1 : 0;
    if (el.isFormField && el.required && !el.filled) progressSignal = Math.max(progressSignal, REQUIRED_FIELD_PROGRESS);
    if (el.isSubmit && requiredEmpty > 0) progressSignal = 0;
    // Re-filling an already filled field is not progress.
    if (el.isFormField && el.filled) progressSignal = 0;

    // Generic hesitation/commitment priors (see constants above).
    let caution = 1;
    if (DESTRUCTIVE_TEXT_PATTERN.test(el.text)) caution *= DESTRUCTIVE_FACTOR;
    if (el.inDialog && requiredEmpty > 0 && !el.isFormField && !el.isSubmit && DISMISS_TEXT_PATTERN.test(el.text)) {
      caution *= DISMISS_WHILE_INCOMPLETE_FACTOR;
    }
    if (el.visited && !el.isFormField) caution *= REVISIT_DIRECT_FACTOR;

    // Goal-directed pull toward this element.
    const clickUtility = (attention + goalSeeking * progressSignal) * caution;
    options.push({
      action: classifyDirectAction(el),
      target: el,
      utility: Math.max(clickUtility, 0),
      signals: { attention, reward: goalSeeking * progressSignal },
    });

    // Curiosity pull toward this element, independent of whether it
    // looks like the "correct" action — much weaker once already
    // visited this run, and weaker on a screen already seen.
    const novelty = (el.visited ? 0.1 : 1) * Math.pow(SCREEN_REVISIT_EXPLORE_FACTOR, screenVisits);
    const exploreUtility = exploration * novelty * caution;
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

  const weights = options.map((o) => Math.exp(o.utility / TEMPERATURE));
  const chosen = weightedPick(ctx.rng, options, weights);

  return {
    action: chosen.action,
    target: chosen.target,
    decision_signals: { ...chosen.signals, time_pressure: timePressure },
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
