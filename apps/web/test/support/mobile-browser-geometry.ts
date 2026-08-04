export interface MobileElementGeometry {
  name: string;
  left: number;
  right: number;
  clientWidth: number;
  scrollWidth: number;
  overflowX: string;
  actionable: boolean;
  coveredByHeader: boolean;
  coveredByComposer: boolean;
  reachable: boolean;
  hidden: boolean;
  focusable: boolean;
  ariaHidden: boolean;
  interceptsAfterClose: boolean;
  intentionalHorizontalOverflow?: boolean;
}

export interface MobileGeometryIssue {
  name: string;
  code:
    | "LEFT_OUTSIDE_VIEWPORT"
    | "RIGHT_OUTSIDE_VIEWPORT"
    | "UNEXPECTED_HORIZONTAL_OVERFLOW"
    | "COVERED_BY_HEADER"
    | "COVERED_BY_COMPOSER"
    | "UNREACHABLE_ACTION"
    | "HIDDEN_FOCUSABLE"
    | "ARIA_HIDDEN_FOCUSABLE"
    | "CLOSED_OVERLAY_INTERCEPTS";
}

/** Pure classifier used by the compiled-browser detector during M10 acceptance. */
export function detectMobileGeometryIssues(
  elements: readonly MobileElementGeometry[],
  viewportWidth: number,
): MobileGeometryIssue[] {
  const issues: MobileGeometryIssue[] = [];
  const report = (name: string, code: MobileGeometryIssue["code"]) => issues.push({ name, code });

  for (const element of elements) {
    if (!element.hidden && element.left < -0.5) report(element.name, "LEFT_OUTSIDE_VIEWPORT");
    if (!element.hidden && element.right > viewportWidth + 0.5 && !element.intentionalHorizontalOverflow) {
      report(element.name, "RIGHT_OUTSIDE_VIEWPORT");
    }
    if (
      !element.hidden &&
      element.scrollWidth > element.clientWidth + 1 &&
      !["auto", "scroll"].includes(element.overflowX) &&
      !element.intentionalHorizontalOverflow
    ) {
      report(element.name, "UNEXPECTED_HORIZONTAL_OVERFLOW");
    }
    if (element.actionable && element.coveredByHeader) report(element.name, "COVERED_BY_HEADER");
    if (element.actionable && element.coveredByComposer) report(element.name, "COVERED_BY_COMPOSER");
    if (element.actionable && !element.reachable) report(element.name, "UNREACHABLE_ACTION");
    if (element.hidden && element.focusable) report(element.name, "HIDDEN_FOCUSABLE");
    if (element.ariaHidden && element.focusable) report(element.name, "ARIA_HIDDEN_FOCUSABLE");
    if (element.interceptsAfterClose) report(element.name, "CLOSED_OVERLAY_INTERCEPTS");
  }

  return issues;
}
