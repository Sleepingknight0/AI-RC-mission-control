import { spawnSync } from "node:child_process";

export interface TailscaleCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface TailscaleCommandResult {
  found: boolean;
  exitCode: number | null;
  stdout: string;
}

export type TailscaleCommandRunner = (
  args: readonly string[],
) => TailscaleCommandResult;

interface TailscaleStatus {
  BackendState?: unknown;
  Self?: {
    DNSName?: unknown;
    Online?: unknown;
  };
}

export function diagnoseTailscale(
  input: {
    coreHost: string;
    corePort: number;
    allowedBrowserOrigins: readonly string[];
  },
  run: TailscaleCommandRunner = runTailscaleCommand,
): TailscaleCheck[] {
  if (input.coreHost !== "127.0.0.1") {
    return [
      {
        name: "Tailscale Serve",
        status: "fail",
        detail: "Core must bind 127.0.0.1 before private proxy deployment",
      },
    ];
  }

  const statusResult = run(["status", "--json"]);
  if (!statusResult.found) {
    return [
      { name: "Tailscale CLI", status: "warn", detail: "not installed or not on PATH" },
      { name: "Tailscale connection", status: "warn", detail: "not checked" },
      { name: "Tailscale exact Origin", status: "warn", detail: "not configured" },
      { name: "Tailscale Serve", status: "warn", detail: "not checked" },
    ];
  }
  if (statusResult.exitCode !== 0) {
    return [
      { name: "Tailscale CLI", status: "pass", detail: "installed" },
      { name: "Tailscale connection", status: "warn", detail: "offline or signed out" },
      { name: "Tailscale exact Origin", status: "warn", detail: "not checked" },
      { name: "Tailscale Serve", status: "warn", detail: "not checked" },
    ];
  }

  let remoteOrigin: string;
  try {
    remoteOrigin = tailscaleOriginFromStatus(statusResult.stdout);
  } catch {
    return [
      { name: "Tailscale CLI", status: "pass", detail: "installed" },
      { name: "Tailscale connection", status: "warn", detail: "offline or invalid status" },
      { name: "Tailscale exact Origin", status: "warn", detail: "not checked" },
      { name: "Tailscale Serve", status: "warn", detail: "not checked" },
    ];
  }

  const exactOriginConfigured = input.allowedBrowserOrigins.includes(remoteOrigin);
  const serveResult = run(["serve", "status", "--json"]);
  const expectedTarget = `http://127.0.0.1:${input.corePort}`;
  let serveConfigured =
    serveResult.exitCode === 0 &&
    serveStatusContainsTarget(serveResult.stdout, expectedTarget);
  if (!serveConfigured) {
    const textStatus = run(["serve", "status"]);
    serveConfigured =
      textStatus.exitCode === 0 &&
      textStatus.stdout.toLowerCase().includes(expectedTarget.toLowerCase());
  }

  return [
    { name: "Tailscale CLI", status: "pass", detail: "installed" },
    { name: "Tailscale connection", status: "pass", detail: "online" },
    {
      name: "Tailscale exact Origin",
      status: exactOriginConfigured ? "pass" : "warn",
      detail: exactOriginConfigured ? remoteOrigin : `${remoteOrigin} is not allowed by Core`,
    },
    {
      name: "Tailscale Serve",
      status: serveConfigured ? "pass" : "warn",
      detail: serveConfigured ? `private proxy to ${expectedTarget}` : "not configured for AICL",
    },
  ];
}

export function tailscaleOriginFromStatus(statusJson: string): string {
  const status = JSON.parse(statusJson) as TailscaleStatus;
  if (status.BackendState !== "Running" || status.Self?.Online === false) {
    throw new Error("Tailscale is not online");
  }
  if (typeof status.Self?.DNSName !== "string") {
    throw new Error("Tailscale status did not include a DNS name");
  }
  const dnsName = status.Self.DNSName.trim().replace(/\.+$/u, "").toLowerCase();
  if (!isTailscaleDnsName(dnsName)) {
    throw new Error("Tailscale DNS name is not an exact ts.net hostname");
  }
  return `https://${dnsName}`;
}

export function isExactTailscaleOrigin(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.origin === candidate &&
    isTailscaleDnsName(url.hostname)
  );
}

export function serveStatusContainsTarget(
  serveStatusJson: string,
  expectedTarget: string,
): boolean {
  try {
    const parsed = JSON.parse(serveStatusJson) as unknown;
    return JSON.stringify(parsed).toLowerCase().includes(expectedTarget.toLowerCase());
  } catch {
    return false;
  }
}

function isTailscaleDnsName(candidate: string): boolean {
  return (
    candidate.endsWith(".ts.net") &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/u.test(candidate)
  );
}

function runTailscaleCommand(args: readonly string[]): TailscaleCommandResult {
  const executable = process.env.AICL_TAILSCALE_PATH?.trim() || "tailscale";
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  });
  const errorCode =
    result.error !== undefined && "code" in result.error ? result.error.code : undefined;
  return {
    found: errorCode !== "ENOENT",
    exitCode: result.status,
    stdout: result.stdout ?? "",
  };
}
