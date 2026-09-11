/**
 * Types matching contracts/abm-behavioral-events.contract.yaml (v0.5).
 *
 * agent_parameters / condition / journey_stage / decision_signals are
 * typed loosely (Record<string, ...>) on purpose — the contract
 * deliberately does not fix their shape at this level; the concrete
 * shape for a given run comes from that run's experiment definition
 * (abm/experiments/<slug>/definition.md), not from this file.
 */

export type AgentParameters = Record<string, number>;

export type DecisionSignals = Record<string, number>;

export type Action =
  | "click"
  | "type"
  | "navigate"
  | "explore"
  | "abandon_idle"
  | "abandon_logout"
  | "wait";

/** One row of contracts/abm-behavioral-events.contract.yaml. */
export interface AbmEvent {
  experiment_id: string;
  run_id: string;
  agent_id: string;
  agent_parameters?: AgentParameters;
  condition: string;
  session_id: string;
  timestamp: string; // ISO 8601 UTC
  screen: string;
  element?: string | null;
  action: Action;
  decision_signals?: DecisionSignals;
  elapsed_time: number; // seconds since this agent's run started
  journey_stage: string;
  journey_completed: boolean;
}

/**
 * A candidate the perception layer found on the current page — generic,
 * carries no notion of "this is the correct one". See src/perception.ts.
 */
export interface PerceivedElement {
  /** Locator string usable to re-find and act on this element (see actuation.ts). */
  ref: string;
  text: string;
  role: string;
  tag: string;
  href: string | null;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  /** Generic visual heuristic — filled/solid background, not "is the intended CTA". */
  isPrimaryStyled: boolean;
  /** Has this agent already interacted with this element this run. */
  visited: boolean;
}

export interface DecisionContext {
  candidates: PerceivedElement[];
  params: AgentParameters;
  elapsedSeconds: number;
  timeoutSeconds: number;
  /** Uniform [0,1) sample, from the run's seeded RNG — never Math.random(). */
  rng: () => number;
}

export interface DecisionResult {
  action: Action;
  target?: PerceivedElement;
  decision_signals: DecisionSignals;
}

/**
 * The one thing that differs per target application. Everything else in
 * this package is generic. See README.md — the filled-in implementation
 * of `authenticate` lives outside this repository, never here.
 */
/**
 * The two things that differ per target application — everything else
 * in this package is generic. The filled-in implementation lives outside
 * this repository, never here (see README.md).
 */
export interface IntegrationModule {
  /**
   * Get `page` into an authenticated session, already on the journey's
   * entry screen (see the experiment definition's "Entry point" section
   * for what that means and why it's not the app's general hub).
   * Everything after this call is genuine perception+decision — this
   * function's only job is establishing where the study begins.
   */
  authenticate(page: import("playwright").Page, account: SyntheticAccount): Promise<void>;

  /**
   * What journey_stage/journey_completed are right now. Requires knowing
   * what "a Company/Team/Member exists" looks like on the target
   * application (a URL pattern, a DOM signal, a state check) —
   * environmental observation, not an answer to "which action is
   * correct" (abm_data_generator.md §8 still holds for decision.ts) — but
   * still real integration knowledge, so it lives here, never in this
   * package.
   */
  getJourneyState(
    page: import("playwright").Page
  ): Promise<{ stage: string; completed: boolean }>;
}

export interface SyntheticAccount {
  /** Whatever identifier the auth module needs — email, id, token, etc. Opaque to this package. */
  identifier: string;
  /** Recorded as `session_id` in every event this account's agent produces. */
  sessionId: string;
}

export interface HarnessConfig {
  baseUrl: string;
  timeoutSeconds: number;
  /** Path to a local module implementing IntegrationModule — resolved at runtime, never committed. */
  integrationModulePath: string;
  outputDir: string;
}
