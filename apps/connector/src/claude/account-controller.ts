import { basename } from "node:path";

import {
  MAX_PROVIDER_NATIVE_SESSIONS,
  ProviderAccountCapabilitySnapshotSchema,
  ProviderNativeSessionSnapshotSchema,
  type ProviderAccountCapabilitySnapshot,
  type ProviderCapabilityEvidence,
  type ProviderNativeSession,
  type ProviderNativeSessionPage,
} from "@aicl/protocol";

import { OpaqueNativeSessionPager } from "../codex/account-controller.js";
import {
  readProviderAccountProfiles,
  type ProviderAccountProfile,
} from "../provider-inventory.js";
import { canonicalProjectRoot } from "../project-root.js";
import {
  UnavailableProvider,
  type ManagedProviderAccount,
  type NativeSessionPageInput,
  type ProviderAccountController,
} from "../provider.js";
import {
  readClaudeAgents,
  readClaudeAuthentication,
  type ClaudeCliRunner,
} from "./cli.js";

const CLAUDE_CAPABILITY_KEYS = [
  "inventory",
  "installation_probe",
  "authentication_probe",
  "list_sessions",
  "read_history",
  "observe_live",
  "create_session",
  "resume_session",
  "submit_turn",
  "steer_turn",
  "interrupt_turn",
  "resolve_approval",
  "read_diffs",
  "read_terminal_evidence",
  "list_models",
  "change_model",
  "reasoning_levels",
  "execution_modes",
  "text_input",
  "file_input",
  "image_input",
  "approval_policies",
  "sandbox_policies",
  "network_policies",
] as const satisfies readonly ProviderCapabilityEvidence["key"][];

export interface ClaudeAccountControllerOptions {
  cwd: string;
  allowedRoots: readonly string[];
  registryRoot?: string;
  timeoutMs?: number;
  command?: string;
  runner?: ClaudeCliRunner;
}

class ClaudeInventoryProvider extends UnavailableProvider {
  constructor(
    readonly accountId: string,
    readonly profile: ProviderAccountProfile,
    readonly options: ClaudeAccountControllerOptions,
  ) {
    super();
  }

  async accountCapabilities(
    revision: number,
    active: boolean,
  ): Promise<ProviderAccountCapabilitySnapshot> {
    const now = new Date();
    const observedAt = now.toISOString();
    const auth = readClaudeAuthentication({
      cwd: this.options.cwd,
      profilePath: this.profile.profilePath,
      ...(this.options.runner === undefined ? {} : { runner: this.options.runner }),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.command === undefined
        ? {}
        : { command: this.options.command }),
    });
    const inventory = readClaudeAgents({
      cwd: this.options.cwd,
      profilePath: this.profile.profilePath,
      ...(this.options.runner === undefined ? {} : { runner: this.options.runner }),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.command === undefined
        ? {}
        : { command: this.options.command }),
    });
    const available = auth.available && inventory.available;
    const unsupportedReason =
      "Installed Claude Code exposes no accepted AICL history/control ownership protocol.";
    const capabilities: ProviderCapabilityEvidence[] =
      CLAUDE_CAPABILITY_KEYS.map((key) => {
        const supported = available && [
          "inventory",
          "installation_probe",
          "authentication_probe",
          "list_sessions",
        ].includes(key);
        return {
          key,
          state: available
            ? supported
              ? ("supported" as const)
              : ("unsupported" as const)
            : ("unknown" as const),
          provenance: "provider_probe" as const,
          observedAt,
          reason: available
            ? supported
              ? null
              : unsupportedReason
            : "Claude Code account probe is unavailable.",
        };
      });
    return ProviderAccountCapabilitySnapshotSchema.parse({
      snapshotId: `claude-account-${crypto.randomUUID()}`,
      revision,
      providerId: "claude",
      accountId: this.accountId,
      source: available ? "provider_probe" : "unavailable",
      observedAt,
      staleAt: new Date(now.getTime() + (available ? 5 * 60_000 : 60_000)).toISOString(),
      freshness: available ? "live" : "unavailable",
      authentication: available
        ? auth.authenticated
          ? "authenticated"
          : "not_authenticated"
        : "unknown",
      control: "inventory_only",
      active,
      capabilities,
      models: [],
      modelsState: "not_supported",
      notice: available
        ? "Claude Session inventory is available; history, live items, and control are unavailable."
        : "Claude account discovery is unavailable.",
    });
  }

  async discoverNativeSessions(input: {
    search: string | null;
    archived: NativeSessionPageInput["archived"];
  }) {
    const observedAt = new Date();
    const result = readClaudeAgents({
      cwd: this.options.cwd,
      profilePath: this.profile.profilePath,
      ...(this.options.runner === undefined ? {} : { runner: this.options.runner }),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.command === undefined
        ? {}
        : { command: this.options.command }),
    });
    if (!result.available) {
      throw new Error("Claude Session inventory is unavailable");
    }
    const sessions: ProviderNativeSession[] = [];
    if (input.archived !== "only") {
      for (const agent of result.agents) {
        let projectPath: string;
        try {
          projectPath = canonicalProjectRoot(agent.cwd, this.options.allowedRoots);
        } catch {
          continue;
        }
        const title = agent.name.trim() || "Claude Session";
        const search = input.search?.trim().toLocaleLowerCase();
        if (
          search !== undefined &&
          search !== "" &&
          !`${title}\n${basename(projectPath)}`.toLocaleLowerCase().includes(search)
        ) {
          continue;
        }
        const startedAt = new Date(agent.startedAt).toISOString();
        sessions.push({
          providerId: "claude",
          accountId: this.accountId,
          providerSessionId: agent.sessionId,
          title,
          preview: null,
          projectPath,
          projectName: basename(projectPath),
          branch: null,
          providerStatus: claudeStatus(agent.status),
          createdAt: startedAt,
          updatedAt: observedAt.toISOString(),
          pinned: false,
          archived: false,
          canResume: false,
        });
      }
    }
    sessions.sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.providerSessionId.localeCompare(right.providerSessionId),
    );
    const truncated = sessions.length > MAX_PROVIDER_NATIVE_SESSIONS;
    return ProviderNativeSessionSnapshotSchema.parse({
      snapshotId: `claude-native-${crypto.randomUUID()}`,
      revision: 1,
      providerId: "claude",
      accountId: this.accountId,
      observedAt: observedAt.toISOString(),
      staleAt: new Date(observedAt.getTime() + 30_000).toISOString(),
      freshness: "live",
      truncated,
      sessions: sessions.slice(0, MAX_PROVIDER_NATIVE_SESSIONS),
      notice:
        "Claude Code exposes inventory only; history, live activity, and safe external control are unavailable.",
    });
  }
}

export class ClaudeAccountController implements ProviderAccountController {
  readonly #options: ClaudeAccountControllerOptions;
  readonly #profiles: Map<string, ProviderAccountProfile>;
  readonly #pager = new OpaqueNativeSessionPager();

  constructor(options: ClaudeAccountControllerOptions) {
    this.#options = options;
    this.#profiles = new Map(
      readProviderAccountProfiles(
        options.registryRoot === undefined
          ? { enabledOnly: true }
          : { registryRoot: options.registryRoot, enabledOnly: true },
      )
        .filter((profile) => profile.providerId === "claude")
        .map((profile) => [profile.accountId, profile]),
    );
  }

  open(providerId: string, accountId: string): ManagedProviderAccount | null {
    if (providerId !== "claude") return null;
    const profile = this.#profiles.get(accountId);
    if (profile === undefined) return null;
    const provider = new ClaudeInventoryProvider(accountId, profile, this.#options);
    return {
      providerId,
      accountId,
      provider,
      capabilities: (revision, active) =>
        provider.accountCapabilities(revision, active),
      identityFingerprint: async () => null,
    };
  }

  rememberIdentity(): void {}

  async nativeSessionPage(
    account: ManagedProviderAccount,
    input: NativeSessionPageInput,
  ): Promise<ProviderNativeSessionPage> {
    if (
      input.providerId !== "claude" ||
      account.providerId !== "claude" ||
      !(account.provider instanceof ClaudeInventoryProvider)
    ) {
      throw new Error("Provider does not support Claude Session discovery");
    }
    const provider = account.provider;
    return this.#pager.page(input, () =>
      provider.discoverNativeSessions({
        search: input.search,
        archived: input.archived,
      }),
    );
  }
}

function claudeStatus(status: string): ProviderNativeSession["providerStatus"] {
  const normalized = status.toLocaleLowerCase();
  if (["active", "running", "working"].includes(normalized)) return "active";
  if (["idle", "completed", "done"].includes(normalized)) return "idle";
  if (["error", "failed"].includes(normalized)) return "error";
  return "not_loaded";
}
