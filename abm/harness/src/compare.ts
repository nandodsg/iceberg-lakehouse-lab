#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { AbmEvent } from "./types.js";

/**
 * Side-by-side run metrics — the yardstick for calibration rounds, so a
 * change to the decision policy is judged on numbers, not on one agent's
 * anecdote. Only contract fields are used.
 *
 *   node dist/compare.js runs/piloto-02.jsonl runs/piloto-03.jsonl ...
 */

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: compare <run.jsonl> [<run.jsonl> ...]");
  process.exit(1);
}

const STAGES = ["none", "company", "team", "member"];

interface RunMetrics {
  run: string;
  agents: number;
  events: number;
  reachedCompany: number;
  reachedTeam: number;
  completed: number;
  medianSecondsToCompany: number | null;
  meanScreens: number;
  meanBackAndForth: number;
  meanOutsideShare: number;
  earlyAbandons: number;
  meanSteps: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const results: RunMetrics[] = [];
for (const file of files) {
  const rows: AbmEvent[] = (await readFile(file, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const byAgent = new Map<string, AbmEvent[]>();
  for (const r of rows) {
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    byAgent.get(r.agent_id)!.push(r);
  }
  // "Home area" = the screen prefix the run started on (entry point); a
  // generic proxy for "left the area under study" without naming routes.
  const secondsToCompany: number[] = [];
  let reachedCompany = 0;
  let reachedTeam = 0;
  let completed = 0;
  let screensTotal = 0;
  let backAndForthTotal = 0;
  let outsideShareTotal = 0;
  let earlyAbandons = 0;
  let stepsTotal = 0;
  for (const ev of byAgent.values()) {
    const entry = ev[0].screen.split("/").filter(Boolean)[0] ?? "";
    const maxStage = ev.reduce((m, e) => Math.max(m, STAGES.indexOf(e.journey_stage)), 0);
    if (maxStage >= 1) reachedCompany++;
    if (maxStage >= 2) reachedTeam++;
    if (ev.some((e) => e.journey_completed)) completed++;
    const first = ev.find((e) => e.journey_stage !== "none");
    if (first) secondsToCompany.push(first.elapsed_time);
    screensTotal += new Set(ev.map((e) => e.screen)).size;
    // back-and-forth: consecutive screen changes that return to the screen
    // two steps earlier (A → B → A).
    let bf = 0;
    const screens = ev.map((e) => e.screen);
    for (let i = 2; i < screens.length; i++) {
      if (screens[i] !== screens[i - 1] && screens[i] === screens[i - 2]) bf++;
    }
    backAndForthTotal += bf;
    const outside = ev.filter((e) => (e.screen.split("/").filter(Boolean)[0] ?? "") !== entry).length;
    outsideShareTotal += outside / ev.length;
    const last = ev[ev.length - 1];
    const timeoutLike = ev.length > 0 && last.elapsed_time >= 0.95 * Math.max(...ev.map((e) => e.elapsed_time));
    if (last.action.startsWith("abandon") && !(last.action === "abandon_idle" && timeoutLike && last.elapsed_time >= 250)) {
      earlyAbandons++;
    }
    stepsTotal += ev.length;
  }
  const n = byAgent.size;
  results.push({
    run: file.replace(/^.*[\\/]/, ""),
    agents: n,
    events: rows.length,
    reachedCompany,
    reachedTeam,
    completed,
    medianSecondsToCompany: median(secondsToCompany),
    meanScreens: screensTotal / n,
    meanBackAndForth: backAndForthTotal / n,
    meanOutsideShare: outsideShareTotal / n,
    earlyAbandons,
    meanSteps: stepsTotal / n,
  });
}

const cols: [string, (m: RunMetrics) => string][] = [
  ["run", (m) => m.run],
  ["agents", (m) => String(m.agents)],
  ["steps/agent", (m) => m.meanSteps.toFixed(0)],
  ["→company", (m) => `${m.reachedCompany}/${m.agents}`],
  ["→team", (m) => `${m.reachedTeam}/${m.agents}`],
  ["completed", (m) => `${m.completed}/${m.agents}`],
  ["median s→company", (m) => (m.medianSecondsToCompany === null ? "—" : m.medianSecondsToCompany.toFixed(0))],
  ["screens/agent", (m) => m.meanScreens.toFixed(1)],
  ["A→B→A/agent", (m) => m.meanBackAndForth.toFixed(1)],
  ["outside share", (m) => (m.meanOutsideShare * 100).toFixed(0) + "%"],
  ["early abandons", (m) => `${m.earlyAbandons}/${m.agents}`],
];
const widths = cols.map(([h, f]) => Math.max(h.length, ...results.map((r) => f(r).length)));
console.log(cols.map(([h], i) => h.padEnd(widths[i])).join("  "));
for (const r of results) console.log(cols.map(([, f], i) => f(r).padEnd(widths[i])).join("  "));
