import { describe, expect, it } from "vitest";

import {
  detectMobileGeometryIssues,
  type MobileElementGeometry,
} from "./support/mobile-browser-geometry.js";

const visibleAction = (overrides: Partial<MobileElementGeometry> = {}): MobileElementGeometry => ({
  name: "button",
  left: 0,
  right: 44,
  clientWidth: 44,
  scrollWidth: 44,
  overflowX: "visible",
  actionable: true,
  coveredByHeader: false,
  coveredByComposer: false,
  reachable: true,
  hidden: false,
  focusable: true,
  ariaHidden: false,
  interceptsAfterClose: false,
  ...overrides,
});

describe("M10 compiled-browser geometry detector", () => {
  it("detects elements outside either viewport edge", () => {
    expect(detectMobileGeometryIssues([
      visibleAction({ name: "left", left: -2, right: 42 }),
      visibleAction({ name: "right", left: 300, right: 346 }),
    ], 320)).toEqual([
      { name: "left", code: "LEFT_OUTSIDE_VIEWPORT" },
      { name: "right", code: "RIGHT_OUTSIDE_VIEWPORT" },
    ]);
  });

  it("detects unexpected element-level horizontal overflow", () => {
    expect(detectMobileGeometryIssues([
      visibleAction({ clientWidth: 200, scrollWidth: 260 }),
    ], 320)).toContainEqual({ name: "button", code: "UNEXPECTED_HORIZONTAL_OVERFLOW" });
  });

  it("permits documented local scrolling for code blocks", () => {
    expect(detectMobileGeometryIssues([
      visibleAction({
        name: "code",
        actionable: false,
        focusable: false,
        clientWidth: 200,
        scrollWidth: 600,
        overflowX: "auto",
        intentionalHorizontalOverflow: true,
      }),
    ], 320)).toEqual([]);
  });

  it("detects actions covered by the header or composer", () => {
    expect(detectMobileGeometryIssues([
      visibleAction({ name: "header-covered", coveredByHeader: true }),
      visibleAction({ name: "composer-covered", coveredByComposer: true }),
    ], 320)).toEqual([
      { name: "header-covered", code: "COVERED_BY_HEADER" },
      { name: "composer-covered", code: "COVERED_BY_COMPOSER" },
    ]);
  });

  it("detects unreachable actions below a bounded sheet", () => {
    expect(detectMobileGeometryIssues([
      visibleAction({ name: "sheet-close", reachable: false }),
    ], 320)).toContainEqual({ name: "sheet-close", code: "UNREACHABLE_ACTION" });
  });

  it("detects hidden and aria-hidden focusable elements", () => {
    expect(detectMobileGeometryIssues([
      visibleAction({ name: "hidden-input", hidden: true }),
      visibleAction({ name: "aria-hidden-input", ariaHidden: true }),
    ], 320)).toEqual([
      { name: "hidden-input", code: "HIDDEN_FOCUSABLE" },
      { name: "aria-hidden-input", code: "ARIA_HIDDEN_FOCUSABLE" },
    ]);
  });

  it("detects a closed overlay that still intercepts controls", () => {
    expect(detectMobileGeometryIssues([
      visibleAction({ name: "closed-drawer", actionable: false, interceptsAfterClose: true }),
    ], 320)).toContainEqual({ name: "closed-drawer", code: "CLOSED_OVERLAY_INTERCEPTS" });
  });
});
