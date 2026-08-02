import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

export const PRODUCTION_STATE_VERSION = 1;

const ProductionStateSchema = z
  .object({
    version: z.literal(PRODUCTION_STATE_VERSION),
    status: z.literal("running"),
    supervisorPid: z.number().int().positive(),
    corePid: z.number().int().positive(),
    connectorPid: z.number().int().positive(),
    startedAt: z.string().datetime(),
    configPath: z.string().min(1),
    buildRoot: z.string().min(1),
    coreUrl: z.string().url(),
    connectorHealthUrl: z.string().url(),
  })
  .strict();

export type ProductionState = z.infer<typeof ProductionStateSchema>;

export function productionRuntimePaths(configPath: string) {
  const runDirectory = join(dirname(configPath), "run");
  return {
    runDirectory,
    statePath: join(runDirectory, "production-state.json"),
    stopRequestPath: join(runDirectory, "stop-request.json"),
  };
}

export function readProductionState(path: string): ProductionState | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Production state is not valid JSON");
  }
  const result = ProductionStateSchema.safeParse(value);
  if (!result.success) throw new Error("Production state has an invalid shape");
  return result.data;
}

export function writeProductionState(path: string, state: ProductionState): void {
  const validated = ProductionStateSchema.parse(state);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
