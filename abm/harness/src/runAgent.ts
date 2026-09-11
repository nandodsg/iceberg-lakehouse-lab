import type { Page } from "playwright";
import type {
  AbmEvent,
  AgentParameters,
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
  let terminalRecorded = false;

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

    const candidates = await perceive(page, { visitedRefs });
    const { stage, completed } = await safeJourneyState(integration, page);

    const result = decide({
      candidates,
      params,
      elapsedSeconds,
      timeoutSeconds: config.timeoutSeconds,
      rng,
    });

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

    await act(page, result, candidates, rng);

    if (result.action === "abandon_idle" || result.action === "abandon_logout" || completed) {
      terminalRecorded = true;
    }
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
