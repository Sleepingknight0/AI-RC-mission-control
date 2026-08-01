import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GENERATED_CODEX_COMPATIBILITY } from "./generated/compatibility.js";
import { platformCommand } from "./command.js";

export interface CompatibilityAssessment {
  compatible: boolean;
  installedVersion: string | null;
  canonicalSchemaSha256: string | null;
  missingMethods: string[];
  reason: string | null;
}

export interface CompatibilityInput {
  versionOutput: string;
  schemaBundle: unknown;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalSchemaHash(schemaBundle: unknown): string {
  return createHash("sha256").update(canonicalJson(schemaBundle)).digest("hex");
}

export function assessCompatibility(
  input: CompatibilityInput,
): CompatibilityAssessment {
  const installedVersion =
    /codex-cli\s+(\d+\.\d+\.\d+)/u.exec(input.versionOutput)?.[1] ?? null;
  const canonicalSchemaSha256 = canonicalSchemaHash(input.schemaBundle);
  const serialized = JSON.stringify(input.schemaBundle);
  const missingMethods = GENERATED_CODEX_COMPATIBILITY.requiredMethods.filter(
    (method) => !serialized.includes(`"${method}"`),
  );

  if (installedVersion !== GENERATED_CODEX_COMPATIBILITY.cliVersion) {
    return {
      compatible: false,
      installedVersion,
      canonicalSchemaSha256,
      missingMethods,
      reason: `Unsupported Codex version ${installedVersion ?? "unknown"}; expected ${GENERATED_CODEX_COMPATIBILITY.cliVersion}.`,
    };
  }
  if (
    canonicalSchemaSha256 !==
    GENERATED_CODEX_COMPATIBILITY.canonicalSchemaSha256
  ) {
    return {
      compatible: false,
      installedVersion,
      canonicalSchemaSha256,
      missingMethods,
      reason: "Installed Codex app-server schema fingerprint is unrecognized.",
    };
  }
  if (missingMethods.length > 0) {
    return {
      compatible: false,
      installedVersion,
      canonicalSchemaSha256,
      missingMethods,
      reason: `Installed schema omits required methods: ${missingMethods.join(", ")}.`,
    };
  }

  return {
    compatible: true,
    installedVersion,
    canonicalSchemaSha256,
    missingMethods,
    reason: null,
  };
}

export function probeInstalledCodex(
  command = process.env.AICL_CODEX_COMMAND ?? "codex",
  cwd = process.cwd(),
): CompatibilityAssessment {
  const versionInvocation = platformCommand(command, ["--version"]);
  const version = spawnSync(versionInvocation.command, versionInvocation.args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: versionInvocation.shell,
  });
  if (version.status !== 0) {
    throw new Error(
      `Unable to execute Codex CLI: ${(version.stderr || version.error?.message || "unknown error").trim()}`,
    );
  }

  const schemaRoot = mkdtempSync(join(tmpdir(), "aicl-codex-schema-"));
  try {
    const schemaInvocation = platformCommand(command, [
      "app-server",
      "generate-json-schema",
      "--out",
      schemaRoot,
    ]);
    const generated = spawnSync(
      schemaInvocation.command,
      schemaInvocation.args,
      {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        shell: schemaInvocation.shell,
      },
    );
    if (generated.status !== 0) {
      throw new Error(
        `Codex schema generation failed: ${(generated.stderr || generated.error?.message || "unknown error").trim()}`,
      );
    }
    const bundle = JSON.parse(
      readFileSync(
        join(schemaRoot, "codex_app_server_protocol.v2.schemas.json"),
        "utf8",
      ),
    ) as unknown;
    return assessCompatibility({
      versionOutput: version.stdout.trim(),
      schemaBundle: bundle,
    });
  } finally {
    rmSync(schemaRoot, { recursive: true, force: true });
  }
}
