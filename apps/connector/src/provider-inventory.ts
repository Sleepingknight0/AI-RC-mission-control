import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  MAX_PROVIDER_ACCOUNTS,
  MAX_PROVIDER_INVENTORY,
  ProviderFleetSnapshotSchema,
  type ProviderAccount,
  type ProviderCapabilityEvidence,
  type ProviderFleetSnapshot,
  type ProviderRecord,
} from "@aicl/protocol";

export const DEFAULT_PROVIDER_REGISTRY_ROOT = join(
  homedir(),
  ".ai-cli-launcher",
);

const REMOTE_CAPABILITY_KEYS = [
  "remote_control",
  "list_sessions",
  "create_session",
  "resume_session",
  "list_models",
  "change_model",
  "reasoning_levels",
  "text_input",
  "approval_policies",
  "sandbox_policies",
  "network_policies",
] as const;

export interface ProviderInventoryOptions {
  registryRoot?: string;
  activeProviderId?: string;
  activeAccountId?: string;
  knownVersions?: Readonly<Record<string, string>>;
  knownCompatibility?: Readonly<Record<string, "compatible" | "incompatible">>;
  revision?: number;
  now?: () => Date;
  pathValue?: string;
  pathExtValue?: string;
}

interface RawProviderManifest {
  id?: unknown;
  displayName?: unknown;
  enabled?: unknown;
  commandCandidates?: unknown;
  executableOverride?: unknown;
  loginDetection?: { relativePaths?: unknown } | undefined;
  usage?: { enabled?: unknown; strategy?: unknown } | undefined;
}

interface RawAccountProfile {
  id?: unknown;
  displayName?: unknown;
  profilePath?: unknown;
  lastUsedAt?: unknown;
}

interface AccountCandidate {
  account: ProviderAccount;
  lastUsedAt: number;
}

export function readProviderFleet(
  options: ProviderInventoryOptions = {},
): ProviderFleetSnapshot {
  const observedAt = (options.now ?? (() => new Date()))();
  const staleAt = new Date(observedAt.getTime() + 5 * 60_000).toISOString();
  const observedAtIso = observedAt.toISOString();
  const registryRoot = options.registryRoot ?? DEFAULT_PROVIDER_REGISTRY_ROOT;
  const providersRoot = join(registryRoot, "providers");

  if (!isDirectory(providersRoot)) {
    return ProviderFleetSnapshotSchema.parse({
      snapshotId: `fleet-${crypto.randomUUID()}`,
      revision: options.revision ?? 1,
      source: "unavailable",
      observedAt: observedAtIso,
      staleAt,
      freshness: "unavailable",
      degraded: false,
      providers: [],
      notice: "Terminal provider registry not found",
    });
  }

  let directories: string[];
  try {
    directories = readdirSync(providersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return ProviderFleetSnapshotSchema.parse({
      snapshotId: `fleet-${crypto.randomUUID()}`,
      revision: options.revision ?? 1,
      source: "unavailable",
      observedAt: observedAtIso,
      staleAt,
      freshness: "unavailable",
      degraded: true,
      providers: [],
      notice: "Terminal provider registry could not be read",
    });
  }

  const providers: ProviderRecord[] = [];
  const seen = new Set<string>();
  let degraded = directories.length > MAX_PROVIDER_INVENTORY;
  for (const directory of directories.slice(0, MAX_PROVIDER_INVENTORY)) {
    let provider: ProviderRecord;
    try {
      provider = readProvider(
        providersRoot,
        directory,
        observedAtIso,
        options,
      );
    } catch {
      provider = unreadableProvider(directory, observedAtIso);
    }
    if (seen.has(provider.providerId)) {
      degraded = true;
      continue;
    }
    seen.add(provider.providerId);
    if (
      provider.installation === "error" ||
      provider.authentication === "error" ||
      provider.compatibility === "error"
    ) {
      degraded = true;
    }
    providers.push(provider);
  }

  return ProviderFleetSnapshotSchema.parse({
    snapshotId: `fleet-${crypto.randomUUID()}`,
    revision: options.revision ?? 1,
    source: "terminal_registry",
    observedAt: observedAtIso,
    staleAt,
    freshness: "local",
    degraded,
    providers,
    notice: degraded ? "Some provider entries could not be fully read" : null,
  });
}

function readProvider(
  providersRoot: string,
  directory: string,
  observedAt: string,
  options: ProviderInventoryOptions,
): ProviderRecord {
  const providerRoot = join(providersRoot, directory);
  const manifestPath = join(providerRoot, "provider.json");
  if (!existsSync(manifestPath)) return unreadableProvider(directory, observedAt);
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as RawProviderManifest;
  const providerId = slug(asString(manifest.id) ?? directory) ?? slug(directory);
  if (providerId === null) return unreadableProvider(directory, observedAt);

  const enabled = manifest.enabled === true;
  const installed = isInstalled(manifest, options);
  const compatibility = options.knownCompatibility?.[providerId] ?? "unknown";
  const loginFiles = safeRelativePaths(
    asStringArray(manifest.loginDetection?.relativePaths),
  );
  const accountResult = readAccounts(
    providerRoot,
    loginFiles,
    providerId,
    observedAt,
    options,
  );
  const authentication = aggregateAuthentication(accountResult.accounts);
  const configuredProvider =
    (options.activeProviderId ?? "codex") === providerId;
  const remotelyControllable =
    providerId === "codex" &&
    configuredProvider &&
    installed &&
    enabled &&
    compatibility === "compatible" &&
    accountResult.accounts.some(
      (account) =>
        account.control === "remote_control" &&
        account.authentication === "authenticated",
    );
  const strategy = asString(manifest.usage?.strategy);
  const usageSupported =
    manifest.usage?.enabled === true && strategy !== "unsupported";
  const capabilities = providerCapabilities({
    observedAt,
    loginProbe: loginFiles.length > 0,
    usageSupported,
    remotelyControllable,
  });

  return {
    providerId,
    displayName: sanitizeText(asString(manifest.displayName), 96) ?? providerId,
    enabled,
    installation: installed ? "installed" : "not_installed",
    authentication,
    compatibility,
    adapterSupport: remotelyControllable ? "remote_control" : "inventory_only",
    version: sanitizeText(options.knownVersions?.[providerId] ?? null, 64),
    freshness: "local",
    observedAt,
    notice: providerNotice({
      enabled,
      installed,
      compatibility,
      accounts: accountResult.total,
      usageSupported,
      remotelyControllable,
    }),
    capabilities,
    accounts: accountResult.accounts,
    accountCount: accountResult.total,
    models: [],
    modelsState: remotelyControllable ? "unavailable" : "not_supported",
    usageState: usageSupported ? "unavailable" : "not_supported",
    usageMeters: [],
  };
}

function readAccounts(
  providerRoot: string,
  loginFiles: readonly string[],
  providerId: string,
  observedAt: string,
  options: ProviderInventoryOptions,
) {
  const accountsRoot = join(providerRoot, "accounts");
  if (!isDirectory(accountsRoot)) return { accounts: [], total: 0 };
  let names: string[];
  try {
    names = readdirSync(accountsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { accounts: [], total: 0 };
  }

  const candidates: AccountCandidate[] = [];
  for (const name of names.slice(0, MAX_PROVIDER_ACCOUNTS)) {
    let profile: RawAccountProfile = {};
    try {
      const profileFile = join(accountsRoot, name, "profile.json");
      if (existsSync(profileFile)) {
        profile = JSON.parse(readFileSync(profileFile, "utf8")) as RawAccountProfile;
      }
    } catch {
      profile = {};
    }
    const accountId = slug(asString(profile.id) ?? name) ?? slug(name);
    if (accountId === null) continue;
    const authentication = authenticationState(
      asString(profile.profilePath),
      loginFiles,
    );
    const lastUsedAt = Date.parse(asString(profile.lastUsedAt) ?? "");
    candidates.push({
      account: {
        accountId,
        displayName:
          sanitizeText(asString(profile.displayName), 96) ?? accountId,
        isDefault: false,
        authentication,
        control: "inventory_only",
        observedAt,
        notice: null,
      },
      lastUsedAt: Number.isNaN(lastUsedAt) ? -1 : lastUsedAt,
    });
  }

  const newest = candidates.reduce(
    (current, candidate, index) =>
      candidate.lastUsedAt > current.value
        ? { index, value: candidate.lastUsedAt }
        : current,
    { index: -1, value: -1 },
  ).index;
  if (newest >= 0) candidates[newest]!.account.isDefault = true;

  const requestedAccount = options.activeAccountId ?? "default";
  const active =
    candidates.find((candidate) => candidate.account.accountId === requestedAccount) ??
    (requestedAccount === "default" && newest >= 0 ? candidates[newest] : undefined);
  if (
    providerId === (options.activeProviderId ?? "codex") &&
    active?.account.authentication === "authenticated" &&
    options.knownCompatibility?.[providerId] === "compatible"
  ) {
    active.account.control = "remote_control";
  }
  return { accounts: candidates.map((candidate) => candidate.account), total: names.length };
}

function providerCapabilities(input: {
  observedAt: string;
  loginProbe: boolean;
  usageSupported: boolean;
  remotelyControllable: boolean;
}): ProviderCapabilityEvidence[] {
  const evidence = (
    key: ProviderCapabilityEvidence["key"],
    state: ProviderCapabilityEvidence["state"],
    provenance: ProviderCapabilityEvidence["provenance"],
    reason: string | null = null,
  ): ProviderCapabilityEvidence => ({
    key,
    state,
    provenance,
    observedAt: input.observedAt,
    reason,
  });
  const result: ProviderCapabilityEvidence[] = [
    evidence("inventory", "supported", "terminal_registry"),
    evidence("installation_probe", "supported", "terminal_registry"),
    evidence(
      "authentication_probe",
      input.loginProbe ? "supported" : "unknown",
      "terminal_registry",
      input.loginProbe ? null : "Registry does not declare login detection",
    ),
    evidence(
      "usage_collection",
      input.usageSupported ? "unknown" : "unsupported",
      "terminal_registry",
      input.usageSupported ? "Collector not executed" : "Collector not supported",
    ),
  ];
  for (const key of REMOTE_CAPABILITY_KEYS) {
    result.push(
      evidence(
        key,
        input.remotelyControllable ? "supported" : "unsupported",
        "adapter_manifest",
        input.remotelyControllable
          ? null
          : "No active compatible AICL adapter for this registry entry",
      ),
    );
  }
  result.push(
    evidence(
      "file_input",
      "unsupported",
      "adapter_manifest",
      "Managed file input adapter is not implemented yet",
    ),
    evidence(
      "image_input",
      input.remotelyControllable ? "unknown" : "unsupported",
      "adapter_manifest",
      input.remotelyControllable
        ? "Model capabilities have not been probed"
        : "No active compatible AICL adapter",
    ),
  );
  return result;
}

function authenticationState(
  profilePath: string | null,
  loginFiles: readonly string[],
): ProviderAccount["authentication"] {
  if (profilePath === null || loginFiles.length === 0) return "unknown";
  try {
    if (!isAbsoluteLocal(profilePath)) return "error";
    const root = resolve(profilePath);
    if (!isDirectory(root)) return "not_authenticated";
    return loginFiles.some((relativePath) => existsSync(join(root, relativePath)))
      ? "authenticated"
      : "not_authenticated";
  } catch {
    return "error";
  }
}

function aggregateAuthentication(accounts: readonly ProviderAccount[]) {
  if (accounts.some((account) => account.authentication === "authenticated")) {
    return "authenticated" as const;
  }
  if (accounts.some((account) => account.authentication === "error")) {
    return "error" as const;
  }
  if (
    accounts.length > 0 &&
    accounts.every((account) => account.authentication === "not_authenticated")
  ) {
    return "not_authenticated" as const;
  }
  return "unknown" as const;
}

function isInstalled(
  manifest: RawProviderManifest,
  options: ProviderInventoryOptions,
) {
  const override = asString(manifest.executableOverride);
  if (override !== null) {
    try {
      return isAbsoluteLocal(override) && existsSync(override);
    } catch {
      return false;
    }
  }
  const candidates = asStringArray(manifest.commandCandidates).filter(
    (candidate) => /^[A-Za-z0-9._-]+$/u.test(candidate),
  );
  const extensions = (options.pathExtValue ?? process.env.PATHEXT ?? "")
    .split(delimiter)
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension));
  for (const directory of (options.pathValue ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    if (!isAbsoluteLocal(directory)) continue;
    for (const candidate of candidates) {
      const base = join(directory, candidate);
      try {
        if (existsSync(base)) return true;
        if (!candidate.includes(".")) {
          for (const extension of extensions) {
            if (existsSync(base + extension)) return true;
          }
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

function unreadableProvider(
  directory: string,
  observedAt: string,
): ProviderRecord {
  const providerId = slug(directory) ?? "unknown";
  return {
    providerId,
    displayName: providerId,
    enabled: false,
    installation: "error",
    authentication: "error",
    compatibility: "error",
    adapterSupport: "inventory_only",
    version: null,
    freshness: "unavailable",
    observedAt,
    notice: "Provider manifest is missing or unreadable",
    capabilities: [
      {
        key: "inventory",
        state: "unknown",
        provenance: "terminal_registry",
        observedAt,
        reason: "Provider manifest is missing or unreadable",
      },
    ],
    accounts: [],
    accountCount: 0,
    models: [],
    modelsState: "error",
    usageState: "error",
    usageMeters: [],
  };
}

function providerNotice(input: {
  enabled: boolean;
  installed: boolean;
  compatibility: "compatible" | "incompatible" | "unknown";
  accounts: number;
  usageSupported: boolean;
  remotelyControllable: boolean;
}) {
  if (!input.installed) return "CLI not found on PATH";
  if (!input.enabled) return "Disabled in the terminal registry";
  if (input.accounts === 0) return "No accounts configured";
  if (input.compatibility === "incompatible") return "Provider is incompatible";
  if (input.remotelyControllable) {
    return input.usageSupported
      ? "Usage unavailable — collector not executed"
      : "Usage unavailable — collector not supported";
  }
  return "Installed · Inventory only";
}

export function sanitizeProviderText(value: string | null, maxLength: number) {
  return sanitizeText(value, maxLength);
}

function sanitizeText(value: string | null, maxLength: number) {
  if (value === null) return null;
  let cleaned = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    cleaned += character;
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength - 1)}…`
    : cleaned;
}

function slug(value: string | null) {
  if (value === null) return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");
  const trimmed = normalized.replace(/^-+/u, "").slice(0, 96);
  return /^[a-z0-9]/u.test(trimmed) ? trimmed : null;
}

function safeRelativePaths(values: readonly string[]) {
  return values.filter(
    (value) =>
      value.length <= 200 &&
      !isAbsolute(value) &&
      !value.split(/[\\/]/u).some((part) => part === ".."),
  );
}

function asString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.length > 0,
      )
    : [];
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isAbsoluteLocal(path: string) {
  if (!isAbsolute(path)) return false;
  if (process.platform === "win32") {
    return /^[A-Za-z]:[\\/]/u.test(path) && !/^(?:\\\\|\/\/)/u.test(path);
  }
  return true;
}
