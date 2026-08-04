import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Static overflow/geometry contracts for the Mobile shell.
 * Browser element-level overflow is validated in compiled Playwright loops;
 * this suite guards the CSS geometry that caused V1 scroll/fixed defects.
 */
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../src/mobile/MobileOverlay.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../src/mobile/MobileComposer.tsx", import.meta.url), "utf8");

describe("M10 V2 mobile overflow and geometry contracts", () => {
  it("locks the shell to dynamic viewport height without body page scroll", () => {
    expect(styles).toMatch(/body:has\(\.mobile-chat-shell\)\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.mobile-chat-shell\s*\{[^}]*height:\s*100dvh/s);
    expect(styles).toMatch(/\.mobile-chat-shell\s*\{[^}]*height:\s*100svh/s);
    expect(styles).toMatch(/\.mobile-chat-shell\s*\{[^}]*overflow:\s*hidden/s);
  });

  it("gives flex children min-height 0 so nested scroll can form", () => {
    expect(styles).toMatch(/\.mobile-chat-main\s*\{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.mobile-chat-timeline\s*\{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.mobile-timeline-scroll\s*\{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.mobile-overlay-panel\s*\{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.mobile-drawer-scroll,\s*\n\s*\.mobile-sheet-scroll\s*\{[^}]*min-height:\s*0/s);
  });

  it("keeps horizontal containment and wrap for long content", () => {
    expect(styles).toMatch(/\.mobile-account-home,\s*\n\s*\.mobile-chat-main\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(styles).toMatch(/\.mobile-timeline-scroll\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(styles).toMatch(/overflow-wrap:\s*anywhere/);
    expect(styles).toMatch(/\.mobile-timeline-scroll pre,\s*\n\s*\.mobile-timeline-scroll code\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it("pins composer and reserves timeline scroll padding above it", () => {
    expect(styles).toMatch(/\.mobile-composer\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(styles).toMatch(/\.mobile-chat-timeline\s*\{[^}]*flex:\s*1 1 auto/s);
    expect(styles).toMatch(/scroll-padding-bottom:\s*28px/);
    expect(styles).toMatch(/\.mobile-timeline-scroll\s*\{[^}]*padding:[\s\S]*32px/s);
  });

  it("sizes drawer and sheets within small-viewport budgets", () => {
    expect(styles).toMatch(/width:\s*min\(88vw,\s*360px\)/);
    expect(styles).toMatch(/max-height:\s*min\(78vh,\s*78dvh\)/);
    expect(styles).toMatch(/--header-h:\s*56px/);
  });

  it("restores body overflow and focus on overlay close", () => {
    expect(overlaySource).toContain("document.body.style.overflow = \"hidden\"");
    expect(overlaySource).toContain("document.body.style.overflow = previousOverflow");
    expect(overlaySource).toContain("returnTarget?.focus");
    expect(overlaySource).toContain('event.key === "Escape"');
  });

  it("hides file input from tab order and accessibility tree", () => {
    expect(composerSource).toContain('aria-hidden="true"');
    expect(composerSource).toContain("tabIndex={-1}");
    expect(composerSource).toContain('type="file"');
  });
});
