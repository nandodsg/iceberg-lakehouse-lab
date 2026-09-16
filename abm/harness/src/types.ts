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
  /** input/select/textarea — something the agent can fill rather than click. */
  isFormField: boolean;
  /** `required` attribute / aria-required on a form field. */
  required: boolean;
  /** Form field already has a non-empty value. */
  filled: boolean;
  /** Submit control of a form (button[type=submit] or default button inside a form). */
  isSubmit: boolean;
  /** Perceived inside an open modal dialog (perception scopes to the topmost one). */
  inDialog: boolean;
  /** `a[href]` whose target resolves to the screen currently shown — following it changes nothing. */
  selfLink: boolean;
}

/**
 * Overridable knobs of the decision policy — every value has a default in
 * decision.ts (the current calibration); a run's config can override any
 * of them so that two policies can be compared without a rebuild.
 * Calibration rounds are recorded in the epic plan as sets of these.
 */
export interface PolicyOverrides {
  temperature?: number;
  /** Multiplier on a filled form field's attention (1 = no discount). */
  filledFieldAttentionFactor?: number;
  /** Multiplier on direct click/navigate utility of an already-used control. */
  revisitDirectFactor?: number;
  /** Per-return multiplier on explore novelty of a screen already seen (1 = off). */
  screenRevisitExploreFactor?: number;
  /** Multiplier on controls with destructive vocabulary. */
  destructiveFactor?: number;
  /** Multiplier on close/cancel controls inside a dialog with empty required fields. */
  dismissWhileIncompleteFactor?: number;
  /** Weight of `commitment × this` added to a goal-coherent candidate's utility (see GoalState). */
  goalPullWeight?: number;
  /** Fraction of `commitment` subtracted from incoherent candidates' utility while a goal is active. */
  distractionDamping?: number;
  /** Base per-step probability (before `× (1 − commitment)`) that an active goal is dropped. */
  goalDropBase?: number;
  /** Steps after which an active goal expires regardless of `commitment`. */
  goalMaxAge?: number;
  /** Per-repetition multiplier on a control's progress signal and attention once acting on it has produced no observable state change (see DecisionContext.noEffectCounts). */
  noEffectDecay?: number;
  /** Accumulated no-effect count at which `frustration` saturates to 1. */
  frustrationSteps?: number;
  /** Weight of `frustration` added directly to a dismiss/cancel control's utility inside a dialog. */
  frustrationDismissWeight?: number;
  /** Weight of `abandonmentPropensity × frustration` added to abandon utility, same form as the time-pressure term. */
  abandonFrustrationWeight?: number;
}

/**
 * A short-lived intention the agent is currently pursuing — see
 * abm/experiments/guided-vs-unguided/definition.md, "Goal state", for the
 * full mechanism (trigger, scope, lifecycle). `null` means no goal is
 * currently active. Persists across steps in runAgent, entering/leaving
 * decide() through DecisionContext/DecisionResult so decide() itself
 * stays a pure function of its inputs.
 */
export type GoalState = { kind: "dialog" | "area"; age: number } | null;

export interface DecisionContext {
  candidates: PerceivedElement[];
  params: AgentParameters;
  elapsedSeconds: number;
  timeoutSeconds: number;
  /** Uniform [0,1) sample, from the run's seeded RNG — never Math.random(). */
  rng: () => number;
  /** How many times this run has already been on the current `screen` (0 = first time). */
  screenVisits: number;
  /** Did `screen` change on this step relative to the previous one (true on the run's first step too). */
  screenChanged: boolean;
  /** The goal carried over from the previous step, or null. See GoalState. */
  goal: GoalState;
  /**
   * Per-`ref` count of consecutive click/navigate attempts on that control
   * that produced no observable change in state (see runAgent.ts — a
   * fingerprint of pathname + dialog-open + candidate set/fill state,
   * compared step to step). Cleared entirely whenever the state does
   * change, so it only ever holds refs still valid on the current
   * candidate set. decide() stays a pure function of its inputs; the
   * fingerprinting and clearing logic lives in runAgent.
   */
  noEffectCounts: Map<string, number>;
  policy?: PolicyOverrides;
}

export interface DecisionResult {
  action: Action;
  target?: PerceivedElement;
  decision_signals: DecisionSignals;
  /** The goal state to carry into the next step's DecisionContext. */
  nextGoal: GoalState;
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
  /**
   * Optional regex (source string) — perceived elements whose text matches
   * are dropped before decision. Generic mechanism for environment noise
   * that is not part of the application under study (a framework's dev
   * overlay, a support-chat widget); the value lives in the local config,
   * never in this package.
   */
  excludeElementPattern?: string;
  /** See PolicyOverrides — omitted keys keep decision.ts defaults. */
  policy?: PolicyOverrides;
}
