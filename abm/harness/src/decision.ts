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
const TEMPERATURE = 1.0;

// Time pressure is a threshold ramp, not linear from the start — the
// agent shouldn't feel time pressure at second 10 of a 600-second run.
// Starts ramping at 70% of the timeout, per abm_data_generator.md §3
// ("pressure from approaching the 10-minute limit").
const PRESSURE_RAMP_START_FRACTION = 0.7;

// Baseline utility for "wait" — small and constant, only wins the
// softmax when every other option's utility is near zero too.
const WAIT_BASE_UTILITY = 0.05;

interface Option {
  action: Action;
  target?: PerceivedElement;
  utility: number;
  signals: Record<string, number>;
}

export function decide(ctx: DecisionContext): DecisionResult {
  const { candidates, params, elapsedSeconds, timeoutSeconds } = ctx;
  const goalSeeking = params.goal_seeking ?? 0.5;
  const exploration = params.exploration ?? 0.5;
  const visualSensitivity = params.visual_sensitivity ?? 0.5;
  const abandonmentPropensity = params.abandonment_propensity ?? 0.5;

  const timePressure = computeTimePressure(elapsedSeconds, timeoutSeconds);

  const options: Option[] = [];

  for (const el of candidates) {
    const salience = computeSalience(el);
    const attention = salience * visualSensitivity;
    const progressSignal = el.isPrimaryStyled ? 1 : 0;

    // Goal-directed pull toward this element.
    const clickUtility = attention + goalSeeking * progressSignal;
    options.push({
      action: classifyDirectAction(el),
      target: el,
      utility: Math.max(clickUtility, 0),
      signals: { attention, reward: goalSeeking * progressSignal },
    });

    // Curiosity pull toward this element, independent of whether it
    // looks like the "correct" action — much weaker once already
    // visited this run.
    const novelty = el.visited ? 0.1 : 1;
    const exploreUtility = exploration * novelty;
    options.push({
      action: "explore",
      target: el,
      utility: Math.max(exploreUtility, 0),
      signals: { attention, reward: exploreUtility },
    });
  }

  // Abandonment: split between idle (went quiet) and logout (explicit
  // exit) — even weight for v1, open question in the experiment
  // definition whether they should differ.
  const abandonUtility = abandonmentPropensity * timePressure;
  options.push({
    action: "abandon_idle",
    utility: abandonUtility * 0.5,
    signals: { penalty: timePressure },
  });
  options.push({
    action: "abandon_logout",
    utility: abandonUtility * 0.5,
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
