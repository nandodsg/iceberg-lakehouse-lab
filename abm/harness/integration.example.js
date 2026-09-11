// Template only — shows the shape an IntegrationModule (src/types.ts) must
// have. Copy this outside the repository (or to a gitignored path) and
// fill in the real implementation there. A filled-in copy must never be
// committed here — see README.md and the confidentiality rule in the
// root AGENTS.md.

/**
 * @param {import("playwright").Page} page
 * @param {{identifier: string, sessionId: string}} account
 */
export async function authenticate(page, account) {
  // Real implementation: get `page` into an authenticated session for
  // `account`, ending up on the journey's entry screen (see the
  // experiment definition's "Entry point" section). Whatever the target
  // application's real login/session mechanism is goes here — never in
  // this repository.
  throw new Error("authenticate() not implemented — this is a template.");
}

/**
 * @param {import("playwright").Page} page
 * @returns {Promise<{stage: string, completed: boolean}>}
 */
export async function getJourneyState(page) {
  // Real implementation: inspect `page` (URL, DOM, or an API call) to
  // determine journey_stage / journey_completed for the experiment being
  // run. Whatever the target application's real signal for "a Company/
  // Team/Member exists" is goes here — never in this repository.
  throw new Error("getJourneyState() not implemented — this is a template.");
}
