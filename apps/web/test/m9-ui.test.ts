import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreateSessionForm } from "../src/m9/ui.js";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("M9 visible form contracts", () => {
  it("emits a browser-valid Session ID pattern under Unicode Sets semantics", () => {
    const html = renderToStaticMarkup(
      createElement(CreateSessionForm, {
        fleet: null,
        selectedProviderId: null,
        selectedAccountId: null,
        onSubmit: () => undefined,
        disabledReason: "No controllable provider",
      }),
    );
    const pattern = html.match(/pattern="([^"]+)"[^>]*placeholder="session-ops-1"/)?.[1];

    expect(pattern).toBeDefined();
    if (pattern === undefined) throw new Error("Session ID pattern is missing");
    expect(() => new RegExp(pattern, "v")).not.toThrow();
    const browserPattern = new RegExp(`^(?:${pattern})$`, "v");
    expect(browserPattern.test("session-live_1.0")).toBe(true);
    expect(browserPattern.test("session live")).toBe(false);
  });

  it("keeps compact text actions at least 44 pixels wide", () => {
    expect(styles).toMatch(
      /\.text-button\s*\{[^}]*min-width:\s*44px/s,
    );
  });
});
