import type { Page } from "playwright";
import type {
  AbmEvent,
  AgentParameters,
  GoalState,
  HarnessConfig,
  IntegrationModule,
  SyntheticAccount,
} from "./types.js";
import { perceive } from "./perception.js";
import { decide } from "./decision.js";
import { act } from "./actuation.js";
import { Recorder } from "./recorder.js";
import { rngForAgent } from "./rng.js";

export interface RunAgentOptions {
  experimentId: string;
  runId: string;
  agentId: string;
  condition: string;
  params: AgentParameters;
  account: SyntheticAccount;
  config: HarnessConfig;
  integration: IntegrationModule;
  page: Page;
  recorder: Recorder;
}

/**
 * One agent's full perceive→decide→act→record loop, from authenticated
 * entry to a terminal action or timeout. This is the whole mechanism in
 * one place — nothing here is application-specific except the two calls
 * into `integration` (authenticate, getJourneyState).
 */
export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const { experimentId, runId, agentId, condition, params, account, config, integration, page, recorder } =
    opts;
  const rng = rngForAgent(runId, agentId);
  const startedAt = Date.now();
  const visitedRefs = new Set<string>();
  const screenVisitCounts = new Map<string, number>();
  let lastScreen = "";
  let goal: GoalState = null;
  const exclude = config.excludeElementPattern ? new RegExp(config.excludeElementPattern, "i") : undefined;
  let terminalRecorded = false;
  let actFailures = 0;

  await integration.authenticate(page, account);

  while (!terminalRecorded) {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    if (elapsedSeconds >= config.timeoutSeconds) {
      // Timeout reached without the agent choosing a terminal action —
      // still needs exactly one terminal event per run (contract quality
      // rule), recorded as an implicit abandon_idle.
      const { stage, completed } = await safeJourneyState(integration, page);
      await recorder.record(
        buildEvent({
          experimentId,
          runId,
          agentId,
          condition,
          params,
          sessionId: account.sessionId,
          page,
          action: "abandon_idle",
          decisionSignals: { time_pressure: 1 },
          elapsedSeconds,
          stage,
          completed,
        })
      );
      break;
    }

    const candidates = await perceive(page, { visitedRefs, exclude });
    const { stage, completed } = await safeJourneyState(integration, page);

    // Screen-level memory: count arrivals, not steps — staying on a screen
    // for 20 steps is one visit.
    const screenNow = safePathname(page);
    const screenChanged = screenNow !== lastScreen;
    if (screenChanged) {
      screenVisitCounts.set(screenNow, (screenVisitCounts.get(screenNow) ?? 0) + 1);
      lastScreen = screenNow;
    }

    const result = decide({
      candidates,
      params,
      elapsedSeconds,
      timeoutSeconds: config.timeoutSeconds,
      rng,
      screenVisits: (screenVisitCounts.get(screenNow) ?? 1) - 1,
      screenChanged,
      goal,
      policy: config.policy,
    });
    goal = result.nextGoal;

    await recorder.record(
      buildEvent({
        experimentId,
        runId,
        agentId,
        condition,
        params,
        sessionId: account.sessionId,
        page,
        action: result.action,
        element: result.target?.text || result.target?.ref,
        decisionSignals: result.decision_signals,
        elapsedSeconds,
        stage,
        completed,
      })
    );

    if (result.target) visitedRefs.add(result.target.ref);

    const outcome = await act(page, result, candidates, rng);
    if (!outcome.ok) {
      // Surface it — a batch of silently failing actions still produces a
      // perfectly well-formed event file (first pilot, 2026-09-15).
      actFailures += 1;
      console.warn(`  [${agentId}] ${result.action} on ${JSON.stringify(result.target?.text ?? null)} failed: ${outcome.error}`);
    }

    if (result.action === "abandon_idle" || result.action === "abandon_logout" || completed) {
      terminalRecorded = true;
      break;
    }

    // Let the page settle after the action, then dwell — a human takes a
    // moment between decisions; the machine would otherwise burn through
    // dozens of steps per second and `elapsed_time` would mean nothing.
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(DWELL_MIN_MS + rng() * (DWELL_MAX_MS - DWELL_MIN_MS));
  }

  if (actFailures > 0) console.warn(`  [${agentId}] ${actFailures} action(s) failed to reach the page`);
}

const DWELL_MIN_MS = 400;
const DWELL_MAX_MS = 1600;

function safePathname(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return page.url();
  }
}

async function safeJourneyState(
  integration: IntegrationModule,
  page: Page
): Promise<{ stage: string; completed: boolean }> {
  try {
    return await integration.getJourneyState(page);
  } catch {
    return { stage: "none", completed: false };
  }
}

function buildEvent(args: {
  experimentId: string;
  runId: string;
  agentId: string;
  condition: string;
  params: AgentParameters;
  sessionId: string;
  page: Page;
  action: AbmEvent["action"];
  element?: string | null;
  decisionSignals: Record<string, number>;
  elapsedSeconds: number;
  stage: string;
  completed: boolean;
}): AbmEvent {
  let screen = args.page.url();
  try {
    screen = new URL(args.page.url()).pathname;
  } catch {
    // keep full URL if it doesn't parse (shouldn't happen for a real page)
  }
  return {
    experiment_id: args.experimentId,
    run_id: args.runId,
    agent_id: args.agentId,
    agent_parameters: args.params,
    condition: args.condition,
    session_id: args.sessionId,
    timestamp: new Date().toISOString(),
    screen,
    element: args.element ?? null,
    action: args.action,
    decision_signals: args.decisionSignals,
    elapsed_time: Math.round(args.elapsedSeconds),
    journey_stage: args.stage,
    journey_completed: args.completed,
  };
}
