import type { Page } from "playwright";
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

export interface PerceptionOptions {
  /** refs already interacted with this run, so novelty can be computed. */
  visitedRefs: Set<string>;
}

export async function perceive(
  page: Page,
  opts: PerceptionOptions
): Promise<PerceivedElement[]> {
  const handles = await page.locator(INTERACTIVE_SELECTOR).all();
  const out: PerceivedElement[] = [];

  for (let i = 0; i < handles.length; i++) {
    const locator = handles[i];
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await locator.boundingBox().catch(() => null);
    const text = ((await locator.innerText().catch(() => "")) || "").trim().slice(0, 120);
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    const role =
      (await locator.getAttribute("role").catch(() => null)) || inferImplicitRole(tag);
    const href = tag === "a" ? await locator.getAttribute("href").catch(() => null) : null;
    const isPrimaryStyled = await looksLikePrimaryAction(locator);

    // ref: stable enough to re-locate this element in the same page
    // lifecycle (nth-match on the same generic selector + tag). Not a
    // semantic identifier of what the element does.
    const ref = `${INTERACTIVE_SELECTOR}::nth=${i}`;

    out.push({
      ref,
      text,
      role,
      tag,
      href,
      boundingBox: box,
      isPrimaryStyled,
      visited: opts.visitedRefs.has(ref),
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
async function looksLikePrimaryAction(locator: import("playwright").Locator): Promise<boolean> {
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
