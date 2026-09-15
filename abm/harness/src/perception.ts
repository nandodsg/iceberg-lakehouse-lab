import type { Page, Locator } from "playwright";
import type { PerceivedElement } from "./types.js";

/**
 * Generic perception layer — reads whatever is actually rendered on
 * `page` and extracts visual/structural features. Knows nothing about
 * any specific application: no hardcoded selector, route, or label ever
 * belongs in this file (abm_data_generator.md §8 — the agent is not told
 * which element is correct; this module must not smuggle that knowledge
 * in through a selector).
 */

const INTERACTIVE_SELECTOR =
  'button, a[href], input:not([type="hidden"]), [role="button"], [role="link"], select, textarea';

// An open modal dialog traps a human's attention (and usually focus) —
// what's behind the overlay is not a real option until it closes. Generic
// HTML/ARIA convention, not app knowledge.
const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"]';

export interface PerceptionOptions {
  /** refs already interacted with this run, so novelty can be computed. */
  visitedRefs: Set<string>;
  /** See HarnessConfig.excludeElementPattern. */
  exclude?: RegExp;
}

export async function perceive(
  page: Page,
  opts: PerceptionOptions
): Promise<PerceivedElement[]> {
  // Scope to the topmost visible dialog when one is open.
  let scope: Locator | Page = page;
  let scopePrefix = "";
  let inDialog = false;
  const dialogs = await page.locator(DIALOG_SELECTOR).all();
  for (let d = dialogs.length - 1; d >= 0; d--) {
    if (await dialogs[d].isVisible().catch(() => false)) {
      scope = dialogs[d];
      scopePrefix = `${DIALOG_SELECTOR} >> nth=${d} >> `;
      inDialog = true;
      break;
    }
  }

  const handles = await scope.locator(INTERACTIVE_SELECTOR).all();
  const out: PerceivedElement[] = [];

  for (let i = 0; i < handles.length; i++) {
    const locator = handles[i];
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const enabled = await locator.isEnabled().catch(() => true);
    if (!enabled) continue;

    const box = await locator.boundingBox().catch(() => null);
    const features = await locator
      .evaluate((el) => {
        const e = el as HTMLElement;
        const tag = e.tagName.toLowerCase();
        const isFormField = tag === "input" || tag === "select" || tag === "textarea";
        const input = e as HTMLInputElement;
        const inputType = tag === "input" ? (input.type || "text").toLowerCase() : null;
        // Accessible-name-ish text, in the order a generic assistive tool
        // would try: explicit label, aria-label, placeholder, own text, title, name.
        let label = "";
        if (isFormField && e.id) {
          const l = e.ownerDocument.querySelector(`label[for="${CSS.escape(e.id)}"]`);
          if (l) label = (l.textContent || "").trim();
        }
        if (!label && isFormField) {
          const wrapping = e.closest("label");
          if (wrapping) label = (wrapping.textContent || "").trim();
        }
        if (!label) label = (e.getAttribute("aria-label") || "").trim();
        if (!label) label = (e.getAttribute("placeholder") || "").trim();
        if (!label) label = (e.innerText || "").trim();
        if (!label) label = (e.getAttribute("title") || "").trim();
        if (!label && isFormField) label = (e.getAttribute("name") || "").trim();
        const required = e.hasAttribute("required") || e.getAttribute("aria-required") === "true";
        let filled = false;
        if (tag === "select") filled = (e as HTMLSelectElement).value !== "";
        else if (isFormField && (inputType === "checkbox" || inputType === "radio")) filled = input.checked;
        else if (isFormField) filled = (input.value || "").trim() !== "";
        const form = e.closest("form");
        const isSubmit =
          !!form &&
          ((tag === "button" && (input.type || "submit").toLowerCase() === "submit") ||
            (tag === "input" && inputType === "submit"));
        return { tag, inputType, label: label.replace(/\s+/g, " ").slice(0, 120), required, filled, isSubmit };
      })
      .catch(() => null);
    if (!features) continue;

    const { tag, label, required, filled, isSubmit } = features;
    if (opts.exclude && opts.exclude.test(label)) continue;
    const isFormField = tag === "input" || tag === "select" || tag === "textarea";
    const role = (await locator.getAttribute("role").catch(() => null)) || inferImplicitRole(tag);
    const href = tag === "a" ? await locator.getAttribute("href").catch(() => null) : null;
    const isPrimaryStyled = await looksLikePrimaryAction(locator);

    // ref: a valid Playwright locator string that re-finds this element in
    // the same page lifecycle (nth match of the same generic selector,
    // inside the same scope). Not a semantic identifier of what it does.
    const ref = `${scopePrefix}${INTERACTIVE_SELECTOR} >> nth=${i}`;

    out.push({
      ref,
      text: label,
      role,
      tag,
      href,
      boundingBox: box,
      isPrimaryStyled,
      visited: opts.visitedRefs.has(ref),
      isFormField,
      required,
      filled,
      isSubmit,
      inDialog,
    });
  }

  return out;
}

function inferImplicitRole(tag: string): string {
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input" || tag === "textarea") return "textbox";
  if (tag === "select") return "listbox";
  return tag;
}

/**
 * Generic "does this look like the primary/solid action button" visual
 * heuristic — solid/filled background distinct from the page background,
 * as opposed to an outline/ghost/text-only control. This is a prior about
 * common UI design conventions, not knowledge of which specific element
 * is correct on any specific application.
 */
async function looksLikePrimaryAction(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((el) => {
      const style = window.getComputedStyle(el as Element);
      const bg = style.backgroundColor;
      // Treat "has a non-transparent, non-white-ish solid background" as
      // the generic signal of a filled/primary-styled control.
      const m = bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (!m) return false;
      const [, r, g, b, a] = m.map(Number);
      const alpha = Number.isNaN(a) ? 1 : a;
      const isWhitish = r > 240 && g > 240 && b > 240;
      return alpha > 0.5 && !isWhitish;
    })
    .catch(() => false);
}
