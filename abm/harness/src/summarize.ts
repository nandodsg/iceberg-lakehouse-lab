#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { AbmEvent } from "./types.js";

/**
 * Reads a run's JSON Lines file and prints, per agent, the lines a human
 * should actually look at — a trajectory of ~150 steps is mostly noise
 * (exploration clicks); what matters is where the agent went, when the
 * journey advanced, what it did in forms, and how it ended.
 *
 *   node dist/summarize.js runs/<run-id>.jsonl            # every agent
 *   node dist/summarize.js runs/<run-id>.jsonl --agent <agent-id> --all
 *
 * Only contract fields are used (contracts/abm-behavioral-events); nothing
 * here knows what the screens or elements mean on any application.
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    all: { type: "boolean", default: false },
  },
});

const file = positionals[0];
if (!file) {
  console.error("Usage: summarize <run.jsonl> [--agent <agent-id>] [--all]");
  process.exit(1);
}

const rows: AbmEvent[] = (await readFile(file, "utf8"))
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const byAgent = new Map<string, AbmEvent[]>();
for (const r of rows) {
  if (values.agent && r.agent_id !== values.agent) continue;
  if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
  byAgent.get(r.agent_id)!.push(r);
}

const STAGE_ORDER = ["none", "company", "team", "member"];

for (const [agentId, ev] of byAgent) {
  const first = ev[0];
  const last = ev[ev.length - 1];
  const params = Object.entries(first.agent_parameters ?? {})
    .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
    .join("  ");
  const counts = ev.reduce<Record<string, number>>((m, e) => ((m[e.action] = (m[e.action] ?? 0) + 1), m), {});
  const screens = [...new Set(ev.map((e) => e.screen))];
  const maxStage = ev.reduce((m, e) => Math.max(m, STAGE_ORDER.indexOf(e.journey_stage)), 0);

  console.log(`\n=== ${agentId}  (${first.condition}, ${ev.length} steps, ${last.elapsed_time}s) ===`);
  console.log(`params: ${params}`);
  console.log(`actions: ${JSON.stringify(counts)}`);
  console.log(`screens visited (${screens.length}): ${screens.join("  ")}`);
  console.log(`max journey_stage: ${STAGE_ORDER[maxStage]}  completed: ${last.journey_completed}  ended by: ${last.action}`);

  console.log(`\n  #    t(s)  screen                                  action          element                                  stage    why`);
  let prevScreen = "";
  let prevStage = "";
  let prevGoal = 0;
  const GOAL_NAMES: Record<number, string> = { 1: "dialog", 2: "area" };
  ev.forEach((e, i) => {
    const reasons: string[] = [];
    if (e.screen !== prevScreen) reasons.push("screen change");
    if (e.journey_stage !== prevStage && i > 0) reasons.push(`stage ${prevStage}→${e.journey_stage}`);
    if (e.action.startsWith("abandon")) reasons.push("TERMINAL");
    const reward = Number(e.decision_signals?.reward ?? 0);
    if ((e.action === "click" || e.action === "type") && reward > 0) reasons.push("goal-directed");
    if (e.action === "type") reasons.push("form input");
    if (Number(e.decision_signals?.time_pressure ?? 0) > 0 && !(i > 0 && Number(ev[i - 1].decision_signals?.time_pressure ?? 0) > 0)) {
      reasons.push("time pressure starts");
    }
    const goalNow = Number(e.decision_signals?.goal ?? 0);
    if (goalNow !== 0 && prevGoal === 0) reasons.push(`goal set (${GOAL_NAMES[goalNow] ?? goalNow})`);
    if (goalNow === 0 && prevGoal !== 0) reasons.push("goal dropped");
    prevGoal = goalNow;
    const noEffect = Number(e.decision_signals?.no_effect ?? 0);
    if (noEffect >= 2) reasons.push(`no-effect click ×${noEffect}`);
    prevScreen = e.screen;
    prevStage = e.journey_stage;
    if (!values.all && reasons.length === 0) return;
    const el = (e.element ?? "").replace(/\s+/g, " ").slice(0, 38);
    console.log(
      `  ${String(i).padStart(3)}  ${String(e.elapsed_time).padStart(4)}  ${e.screen.slice(0, 38).padEnd(38)}  ${e.action.padEnd(14)}  ${el.padEnd(38)}  ${e.journey_stage.padEnd(7)}  ${reasons.join(", ")}`
    );
  });
}
