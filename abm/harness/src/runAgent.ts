import type { Page } from "playwright";
import type {
  AbmEvent,
  Action,
  AgentParameters,
  GoalState,
  HarnessConfig,
  IntegrationModule,
  PerceivedElement,
  SyntheticAccount,
} from "./types.js";
import { perceive } from "./perception.js";
import { decide, isDismissControl, memoryKey } from "./decision.js";
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
  // Action-outcome mechanism (definition.md, "Action outcome") — see
  // computeStateKey below. Accumulates per-control counts (memoryKey) of
  // click/navigate attempts that produced no observable effect. Scoped by
  // container, not by fingerprint: dialog-level memory ("d|…") lives as
  // long as that dialog is open, page-level memory ("p|…") as long as the
  // pathname holds. When the agent closes a dialog it had been failing in,
  // the failures are carried onto the control that opened it.
  const noEffectCounts = new Map<string, number>();
  let prevStateKey: string | null = null;
  let prevPathname: string | null = null;
  let prevDialogOpen = false;
  let prevAction: Action | null = null;
  let prevTarget: PerceivedElement | null = null;
  let openerKey: string | null = null;
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

    // Did the previous step's action change anything observable? Compared
    // against the fingerprint taken right before that action (this same
    // computation, one iteration ago). A match on a click/navigate means
    // that action had no effect. A mismatch by itself means nothing for
    // the memory — typing in a field or a control appearing next to the
    // button are not evidence that the button now works. Only leaving the
    // container (the dialog closing, the pathname changing) retires it.
    const pathnameNow = safePathname(page);
    const dialogOpenNow = candidates.some((c) => c.inDialog);
    const stateKeyNow = computeStateKey(pathnameNow, dialogOpenNow, candidates);
    if (prevStateKey !== null) {
      if (stateKeyNow === prevStateKey) {
        if ((prevAction === "click" || prevAction === "navigate") && prevTarget) {
          const key = memoryKey(prevTarget);
          noEffectCounts.set(key, (noEffectCounts.get(key) ?? 0) + 1);
        }
      }
      if (pathnameNow !== prevPathname) {
        // New screen, new forms: nothing learned here carries over.
        noEffectCounts.clear();
      } else if (dialogOpenNow && !prevDialogOpen) {
        // A dialog just opened — remember what opened it; its own memory
        // starts fresh (page-level memory stays, it is still that page).
        openerKey = prevTarget ? memoryKey(prevTarget) : null;
        clearDialogMemory(noEffectCounts);
      } else if (!dialogOpenNow && prevDialogOpen) {
        // The dialog closed. If the agent closed it itself after failing
        // in it, the failures move onto whatever opened it — "I tried that
        // form n times and gave up" — so reopening it stops looking like
        // progress. A dialog that closed any other way (submit accepted,
        // nothing had failed) takes its memory with it.
        const gaveUp = prevAction !== "type" && prevTarget !== null && isDismissControl(prevTarget);
        let failed = 0;
        for (const [k, n] of noEffectCounts) if (k.startsWith("d|")) failed += n;
        clearDialogMemory(noEffectCounts);
        if (gaveUp && failed > 0 && openerKey) {
          noEffectCounts.set(openerKey, (noEffectCounts.get(openerKey) ?? 0) + failed);
        }
        openerKey = null;
      }
    }
    prevPathname = pathnameNow;
    prevDialogOpen = dialogOpenNow;

    // Screen-level memory: count arrivals, not steps — staying on a screen
    // for 20 steps is one visit.
    const screenNow = pathnameNow;
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
      noEffectCounts,
      policy: config.policy,
    });
    goal = result.nextGoal;
    prevStateKey = stateKeyNow;
    prevAction = result.action;
    prevTarget = result.target ?? null;

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

/**
 * A fingerprint of everything about the page a human would notice: which
 * screen, whether a dialog is open, and the ordered set of controls with
 * their text and filled state. Not a cryptographic hash — a plain
 * canonical string, since the only use is exact-match comparison one step
 * apart, never storage or logging. Two consecutive fingerprints being
 * equal is how runAgent tells that the last action (if it was a
 * click/navigate) produced no observable effect — see noEffectCounts
 * above and DecisionContext.noEffectCounts.
 */
function computeStateKey(pathname: string, dialogOpen: boolean, candidates: PerceivedElement[]): string {
  const parts = candidates.map((c) => `${c.ref}|${c.text}|${c.filled ? "1" : "0"}`).sort();
  return `${pathname}|${dialogOpen ? "1" : "0"}|${parts.join("~")}`;
}

/** Drops the dialog-scoped ("d|…") no-effect memory, keeping the page-scoped ("p|…") part. */
function clearDialogMemory(counts: Map<string, number>): void {
  for (const k of [...counts.keys()]) if (k.startsWith("d|")) counts.delete(k);
}

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
