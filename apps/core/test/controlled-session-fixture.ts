import {
  makeEnvelope,
  type ProviderCapabilityKey,
  type ProviderFleetSnapshot,
  type ServerEnvelope,
} from "@aicl/protocol";

export interface ControlledBrowser {
  socket: { send(data: string): unknown };
  messages: ServerEnvelope[];
}

export function controlledProviderFleet(
  revision: number,
  providerId = "test-provider",
  accountId = "default",
): ProviderFleetSnapshot {
  const observedAt = new Date().toISOString();
  const capabilities: ProviderCapabilityKey[] = [
    "remote_control",
    "create_session",
    "resume_session",
    "text_input",
    "execution_modes",
    "approval_policies",
    "sandbox_policies",
  ];
  return {
    snapshotId: `controlled-fleet-${revision}`,
    revision,
    source: "connector_fallback",
    observedAt,
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    freshness: "live",
    degraded: false,
    providers: [
      {
        providerId,
        displayName: "Controlled test provider",
        enabled: true,
        installation: "installed",
        authentication: "authenticated",
        compatibility: "compatible",
        adapterSupport: "remote_control",
        version: "test",
        freshness: "live",
        observedAt,
        notice: null,
        capabilities: capabilities.map((key) => ({
          key,
          state: "supported",
          provenance: "adapter_manifest",
          observedAt,
          reason: null,
        })),
        accounts: [
          {
            accountId,
            displayName: "Controlled account",
            isDefault: true,
            authentication: "authenticated",
            control: "remote_control",
            observedAt,
            notice: null,
          },
        ],
        accountCount: 1,
        models: [],
        modelsState: "available",
        usageState: "not_supported",
        usageMeters: [],
      },
    ],
    notice: null,
  };
}

export async function createControlledSession(
  browser: ControlledBrowser,
  sessionId: string,
  options: {
    providerId?: string;
    accountId?: string;
    projectPath?: string;
    model?: string | null;
  } = {},
) {
  await waitUntil(() =>
    browser.messages.some((message) => message.type === "providers.snapshot"),
  );
  const commandId = `create-${sessionId}`;
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("session.create", {
        commandId,
        sessionId,
        deviceId: "controlled-device",
        title: sessionId,
        providerId: options.providerId ?? "test-provider",
        accountId: options.accountId ?? "default",
        projectPath: options.projectPath ?? process.cwd(),
        model: options.model ?? null,
        reasoningLevel: null,
      }),
    ),
  );
  await waitUntil(() =>
    browser.messages.some(
      (message) =>
        message.type === "session.provider.status" &&
        message.payload.commandId === commandId &&
        message.payload.status === "ready",
    ),
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out creating controlled Session");
}
