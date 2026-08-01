import { describe, expect, it } from "vitest";

import { platformCommand } from "../src/codex/command.js";

describe("Codex process command construction", () => {
  it("quotes Windows commands and arguments without shell:true", () => {
    expect(
      platformCommand("C:\\Program Files\\Codex\\codex.cmd", [
        "app-server",
        "--out",
        "C:\\Temp Folder\\schema",
      ], "win32"),
    ).toEqual({
      command:
        '"C:\\Program Files\\Codex\\codex.cmd" app-server --out "C:\\Temp Folder\\schema"',
      args: [],
      shell: true,
    });
  });
});
