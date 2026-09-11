import type { Page } from "playwright";
import type { DecisionResult, PerceivedElement } from "./types.js";
import type { Rng } from "./rng.js";

/**
 * Executes whatever decide() (decision.ts) chose. Generic across any
 * application — no route, selector, or credential specific to any real
 * target ever belongs in this file.
 */

// Common sign-out vocabulary across languages — a generic UI convention,
// not knowledge specific to any one application.
const LOGOUT_TEXT_PATTERN = /\b(log ?out|sign ?out|sair|encerrar sess[ãa]o)\b/i;

export async function act(
  page: Page,
  result: DecisionResult,
  candidates: PerceivedElement[],
  rng: Rng
): Promise<void> {
  switch (result.action) {
    case "click":
    case "explore":
    case "navigate": {
      if (!result.target) return;
      await page.locator(result.target.ref).first().click({ timeout: 5000 }).catch(() => {});
      return;
    }
    case "type": {
      if (!result.target) return;
      const value = syntheticValueFor(result.target, rng);
      await page
        .locator(result.target.ref)
        .first()
        .fill(value, { timeout: 5000 })
        .catch(() => {});
      return;
    }
    case "abandon_logout": {
      const logoutCandidate = candidates.find((c) => LOGOUT_TEXT_PATTERN.test(c.text));
      if (logoutCandidate) {
        await page.locator(logoutCandidate.ref).first().click({ timeout: 5000 }).catch(() => {});
      }
      // If no logout control is visible on the current screen, the run
      // still ends here (orchestrator treats abandon_* as terminal) —
      // recorded as an intended-but-unactionable logout, not silently
      // relabeled as abandon_idle.
      return;
    }
    case "abandon_idle":
    case "wait":
    default:
      // No-op. abandon_idle/wait deliberately do nothing to the page.
      return;
  }
}

/**
 * Generic synthetic value for a form field — no knowledge of what the
 * field means on any specific application. Uses only generic HTML
 * attributes (input type, placeholder/name keywords in common
 * languages) as hints, the same way a generic form-autofill tool would.
 */
function syntheticValueFor(el: PerceivedElement, rng: Rng): string {
  const hint = (el.text || "").toLowerCase();
  const n = Math.floor(rng() * 100000);
  if (/e-?mail/.test(hint)) return `agent.${n}@example.com`;
  if (/(phone|tel|telefone)/.test(hint)) return `+1555${String(n).padStart(7, "0")}`;
  if (/(number|número|quantidade)/.test(hint)) return String(n);
  return `Agent Input ${n}`;
}
