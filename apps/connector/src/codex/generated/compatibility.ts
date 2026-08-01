export const GENERATED_CODEX_COMPATIBILITY = {
  cliVersion: "0.146.0",
  versionOutput: "codex-cli 0.146.0",
  canonicalSchemaSha256:
    "b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03",
  schemaFileCount: 275,
  requiredMethods: [
    "initialize",
    "thread/start",
    "thread/read",
    "thread/resume",
    "turn/start",
    "turn/interrupt",
    "turn/completed",
    "item/agentMessage/delta",
    "item/completed",
  ],
} as const;
