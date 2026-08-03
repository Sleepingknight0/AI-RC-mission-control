import { describe, expect, it } from "vitest";

import {
  diagnoseTailscale,
  isExactTailscaleOrigin,
  selectTailscaleExecutable,
  serveStatusContainsTarget,
  tailscaleOriginFromStatus,
  type TailscaleCommandRunner,
} from "../src/tailscale-diagnostics.js";

const statusJson = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "mission-control.example.ts.net.", Online: true },
});

describe("Tailscale diagnostics", () => {
  it("derives only an exact HTTPS ts.net origin", () => {
    expect(tailscaleOriginFromStatus(statusJson)).toBe(
      "https://mission-control.example.ts.net",
    );
    expect(isExactTailscaleOrigin("https://mission-control.example.ts.net")).toBe(true);
    expect(isExactTailscaleOrigin("https://*.example.ts.net")).toBe(false);
    expect(isExactTailscaleOrigin("http://mission-control.example.ts.net")).toBe(false);
    expect(isExactTailscaleOrigin("https://mission-control.example.ts.net/path")).toBe(false);
  });

  it("reports CLI, connection, origin, and Serve independently", () => {
    const run: TailscaleCommandRunner = (args) =>
      args[0] === "status"
        ? { found: true, exitCode: 0, stdout: statusJson }
        : {
            found: true,
            exitCode: 0,
            stdout: JSON.stringify({
              Web: {
                "mission-control.example.ts.net:443": {
                  Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } },
                },
              },
            }),
          };

    expect(
      diagnoseTailscale(
        {
          coreHost: "127.0.0.1",
          corePort: 8787,
          allowedBrowserOrigins: ["https://mission-control.example.ts.net"],
        },
        run,
      ),
    ).toEqual([
      { name: "Tailscale CLI", status: "pass", detail: "installed" },
      { name: "Tailscale connection", status: "pass", detail: "online" },
      {
        name: "Tailscale exact Origin",
        status: "pass",
        detail: "https://mission-control.example.ts.net",
      },
      {
        name: "Tailscale Serve",
        status: "pass",
        detail: "private proxy to http://127.0.0.1:8787",
      },
    ]);
  });

  it("distinguishes missing CLI from an unconfigured private route", () => {
    const missing = diagnoseTailscale(
      { coreHost: "127.0.0.1", corePort: 8787, allowedBrowserOrigins: [] },
      () => ({ found: false, exitCode: null, stdout: "" }),
    );
    expect(missing.map((check) => check.detail)).toContain("not installed or not on PATH");

    const noServe = diagnoseTailscale(
      { coreHost: "127.0.0.1", corePort: 8787, allowedBrowserOrigins: [] },
      (args) =>
        args[0] === "status"
          ? { found: true, exitCode: 0, stdout: statusJson }
          : { found: true, exitCode: 0, stdout: "{}" },
    );
    expect(noServe.find((check) => check.name === "Tailscale exact Origin")?.status).toBe(
      "warn",
    );
    expect(noServe.find((check) => check.name === "Tailscale Serve")?.detail).toBe(
      "not configured for AICL",
    );
  });

  it("rejects non-loopback Serve targets and malformed status output", () => {
    expect(
      diagnoseTailscale(
        { coreHost: "::1", corePort: 8787, allowedBrowserOrigins: [] },
        () => ({ found: true, exitCode: 0, stdout: statusJson }),
      )[0]?.status,
    ).toBe("fail");
    expect(serveStatusContainsTarget("not-json", "http://127.0.0.1:8787")).toBe(false);
    expect(() => tailscaleOriginFromStatus("{}")).toThrow("not online");
  });

  it("discovers the standard Windows install when Tailscale is not on PATH", () => {
    const installed = "C:\\Program Files\\Tailscale\\tailscale.exe";
    expect(
      selectTailscaleExecutable(
        { ProgramFiles: "C:\\Program Files" },
        "win32",
        (candidate) => candidate === installed,
      ),
    ).toBe(installed);
    expect(
      selectTailscaleExecutable(
        { AICL_TAILSCALE_PATH: "D:\\Tools\\tailscale.exe" },
        "win32",
        () => false,
      ),
    ).toBe("D:\\Tools\\tailscale.exe");
  });
});
