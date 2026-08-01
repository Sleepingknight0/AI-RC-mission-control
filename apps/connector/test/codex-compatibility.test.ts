import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessCompatibility,
  canonicalSchemaHash,
} from "../src/codex/compatibility.js";
import { GENERATED_CODEX_COMPATIBILITY } from "../src/codex/generated/compatibility.js";

const generatedBundle = JSON.parse(
  readFileSync(
    resolve(
      "src/codex/generated/schema/codex_app_server_protocol.v2.schemas.json",
    ),
    "utf8",
  ),
) as unknown;

describe("installed Codex compatibility gate", () => {
  it("accepts the generated 0.146.0 schema", () => {
    expect(
      assessCompatibility({
        versionOutput: GENERATED_CODEX_COMPATIBILITY.versionOutput,
        schemaBundle: generatedBundle,
      }),
    ).toMatchObject({ compatible: true, missingMethods: [] });
  });

  it("rejects unknown versions and fingerprints", () => {
    expect(
      assessCompatibility({
        versionOutput: "codex-cli 0.147.0",
        schemaBundle: generatedBundle,
      }).compatible,
    ).toBe(false);
    expect(
      assessCompatibility({
        versionOutput: GENERATED_CODEX_COMPATIBILITY.versionOutput,
        schemaBundle: { incompatible: true },
      }).compatible,
    ).toBe(false);
  });

  it("uses canonical object ordering for the schema fingerprint", () => {
    expect(canonicalSchemaHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalSchemaHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});
