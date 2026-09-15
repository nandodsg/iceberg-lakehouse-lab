import type { Page } from "playwright";
import type { DecisionResult, PerceivedElement } from "./types.js";
import type { Rng } from "./rng.js";
import { LOGOUT_TEXT_PATTERN } from "./decision.js";

/**
 * Executes whatever decide() (decision.ts) chose. Generic across any
 * application — no route, selector, or credential specific to any real
 * target ever belongs in this file.
 *
 * Returns whether the action actually reached the page. A failed action
 * is reported, never swallowed: the first pilot (2026-09-15) ran an
 * entire batch whose clicks were all failing on an invalid locator while
 * every step was still being recorded as if it had happened.
 */

const ACTION_TIMEOUT_MS = 5000;

export interface ActOutcome {
  ok: boolean;
  error?: string;
}

export async function act(
  page: Page,
  result: DecisionResult,
  candidates: PerceivedElement[],
  rng: Rng
): Promise<ActOutcome> {
  try {
    switch (result.action) {
      case "click":
      case "explore":
      case "navigate": {
        if (!result.target) return { ok: false, error: "no target" };
        if (result.target.isFormField) {
          // "explore" landing on a form field — still fill it; a human
          // poking at a field types something.
          await fillField(page, result.target, rng);
        } else {
          await page.locator(result.target.ref).click({ timeout: ACTION_TIMEOUT_MS });
        }
        return { ok: true };
      }
      case "type": {
        if (!result.target) return { ok: false, error: "no target" };
        await fillField(page, result.target, rng);
        return { ok: true };
      }
      case "abandon_logout": {
        // decision.ts attaches the sign-out control as target when one is
        // visible (LOGOUT_TEXT_PATTERN); `candidates` kept for the fallback.
        const logoutCandidate = result.target ?? candidates.find((c) => LOGOUT_TEXT_PATTERN.test(c.text));
        if (logoutCandidate) {
          await page.locator(logoutCandidate.ref).click({ timeout: ACTION_TIMEOUT_MS });
        }
        // If no logout control is visible on the current screen, the run
        // still ends here (orchestrator treats abandon_* as terminal) —
        // recorded as an intended-but-unactionable logout, not silently
        // relabeled as abandon_idle.
        return { ok: true };
      }
      case "abandon_idle":
      case "wait":
      default:
        // No-op. abandon_idle/wait deliberately do nothing to the page.
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message.split("\n")[0] };
  }
}

async function fillField(page: Page, el: PerceivedElement, rng: Rng): Promise<void> {
  const locator = page.locator(el.ref);
  if (el.tag === "select") {
    // Pick a random non-empty option — generic, no knowledge of what the
    // options mean.
    const values = await locator.evaluate((node) =>
      Array.from((node as HTMLSelectElement).options)
        .map((o) => o.value)
        .filter((v) => v !== "")
    );
    if (values.length === 0) return;
    await locator.selectOption(values[Math.floor(rng() * values.length)], { timeout: ACTION_TIMEOUT_MS });
    return;
  }
  const inputType = await locator.evaluate((node) => ((node as HTMLInputElement).type || "text").toLowerCase());
  if (inputType === "checkbox" || inputType === "radio") {
    await locator.check({ timeout: ACTION_TIMEOUT_MS });
    return;
  }
  if (inputType === "file" || inputType === "submit" || inputType === "button" || inputType === "image") {
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
    return;
  }
  await locator.fill(syntheticValueFor(el, inputType, rng), { timeout: ACTION_TIMEOUT_MS });
}

/**
 * Generic synthetic value for a form field — no knowledge of what the
 * field means on any specific application. Uses only generic HTML
 * attributes (input type, label/placeholder/name keywords in common
 * languages) as hints, the same way a generic form-autofill tool would.
 */
function syntheticValueFor(el: PerceivedElement, inputType: string, rng: Rng): string {
  const hint = (el.text || "").toLowerCase();
  const n = Math.floor(rng() * 100000);
  if (inputType === "email" || /e-?mail/.test(hint)) return `agent.${n}@example.com`;
  if (inputType === "url" || /\b(url|site|website|link)\b/.test(hint)) return `https://agent-${n}.example.com`;
  if (inputType === "tel" || /(phone|tel|telefone)/.test(hint)) return `+1555${String(n).padStart(7, "0")}`;
  if (inputType === "number" || /(number|número|quantidade)/.test(hint)) return String(1 + (n % 50));
  if (inputType === "date") return "2026-01-15";
  if (inputType === "password") return `Agent-${n}-pass`;
  return `Agent ${n}`;
}
