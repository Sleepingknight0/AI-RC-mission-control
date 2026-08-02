import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  PRODUCTION_STATE_VERSION,
  productionRuntimePaths,
  readProductionState,
  writeProductionState,
} from "../src/runtime-files.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("writes production state atomically without runtime capabilities", () => {
  const root = mkdtempSync(join(tmpdir(), "aicl-state-test-"));
  temporaryDirectories.push(root);
  const paths = productionRuntimePaths(join(root, "config.json"));
  writeProductionState(paths.statePath, {
    version: PRODUCTION_STATE_VERSION,
    status: "running",
    supervisorPid: 10,
    corePid: 11,
    connectorPid: 12,
    startedAt: "2026-08-03T00:00:00.000Z",
    configPath: join(root, "config.json"),
    buildRoot: join(root, "build"),
    coreUrl: "http://127.0.0.1:8787",
    connectorHealthUrl: "http://127.0.0.1:8788",
  });

  expect(readProductionState(paths.statePath)).toMatchObject({
    version: PRODUCTION_STATE_VERSION,
    status: "running",
    supervisorPid: 10,
  });
  expect(JSON.stringify(readProductionState(paths.statePath))).not.toMatch(
    /token|secret|capability/iu,
  );
});
