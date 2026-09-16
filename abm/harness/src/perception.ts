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

// Minimum relative-luminance gap between a control's own solid background
// and the surface it sits on for it to read as "primary/filled" (see
// looksLikePrimaryAction). On a 0..1 scale: a near-black or saturated
// button on a light panel (or a light button on a dark one) clears it
// easily; a subtle hover/active tint does not.
const PRIMARY_CONTRAST_MIN = 0.35;

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

    // A link back to the current screen (typically the highlighted "you
    // are here" item of a navigation bar). Compared by pathname only —
    // query/hash differences don't make it a different screen for the
    // purposes of this model.
    let selfLink = false;
    if (tag === "a" && href) {
      try {
        selfLink = new URL(href, page.url()).pathname === new URL(page.url()).pathname;
      } catch {
        selfLink = false;
      }
    }
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
      selfLink,
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
 * heuristic — a solid background that contrasts with the surface it sits
 * on, as opposed to an outline/ghost/text-only control. This is a prior
 * about common UI design conventions, not knowledge of which specific
 * element is correct on any specific application.
 *
 * Two lessons from the first six calibration rounds (2026-09-15), during
 * which this returned false for EVERY element on the target application:
 * - Chromium serializes computed colors declared in modern CSS color
 *   spaces (`oklch()`, `lab()`, `color()` — what Tailwind v4 emits for its
 *   whole palette) in that syntax, not as `rgb()`. Matching `rgba?(` was
 *   therefore never true. The color is now resolved by painting it onto a
 *   1×1 canvas and reading the pixel back — sRGB bytes whatever the input
 *   syntax.
 * - "Solid and not white-ish" assumed a light theme. Agents routinely
 *   toggle the application's theme mid-run, after which the primary
 *   control is light on dark. Contrast against the nearest opaque
 *   ancestor's background is theme-independent.
 */
async function looksLikePrimaryAction(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((el, minContrast) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      const SENTINEL = "#010203";
      // Any CSS color syntax → [r, g, b, alpha 0..1], or null if unparseable.
      const toRgba = (css: string): [number, number, number, number] | null => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = SENTINEL;
        ctx.fillStyle = css;
        if (ctx.fillStyle === SENTINEL) return null;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      // WCAG relative luminance, 0 (black) .. 1 (white).
      const luminance = ([r, g, b]: [number, number, number, number]): number => {
        const lin = (c: number) => {
          c /= 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const own = toRgba(getComputedStyle(el as Element).backgroundColor);
      if (!own || own[3] <= 0.5) return false;
      // The surface the control sits on: nearest ancestor with an opaque
      // enough background (a dialog panel, a card, the page), else the
      // browser's default white canvas.
      let backdrop: [number, number, number, number] | null = null;
      for (let p = (el as Element).parentElement; p && !backdrop; p = p.parentElement) {
        const c = toRgba(getComputedStyle(p).backgroundColor);
        if (c && c[3] > 0.5) backdrop = c;
      }
      if (!backdrop) backdrop = [255, 255, 255, 1];
      return Math.abs(luminance(own) - luminance(backdrop)) >= minContrast;
    }, PRIMARY_CONTRAST_MIN)
    .catch(() => false);
}
