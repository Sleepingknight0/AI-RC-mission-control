import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

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

export interface ProviderAccountProfile {
  providerId: string;
  accountId: string;
  displayName: string;
  profilePath: string;
}

export class ProviderEnablementMutationError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_NOT_FOUND"
      | "PROVIDER_ENABLEMENT_CONFLICT"
      | "PROVIDER_REGISTRY_UNAVAILABLE"
      | "PROVIDER_MANIFEST_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProviderEnablementMutationError";
  }
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
  const compatibility = options.knownCompatibility?.[providerId] ?? "unknown";
  if (!enabled) {
    return {
      providerId,
      displayName: sanitizeText(asString(manifest.displayName), 96) ?? providerId,
      enabled: false,
      installation: "unknown",
      authentication: "unknown",
      compatibility,
      adapterSupport: "inventory_only",
      version: sanitizeText(options.knownVersions?.[providerId] ?? null, 64),
      freshness: "local",
      observedAt,
      notice: "Disabled; installation, authentication, models, usage, and Sessions were not probed",
      capabilities: providerCapabilities({
        observedAt,
        enabled: false,
        loginProbe: false,
        usageSupported: false,
        remotelyControllable: false,
      }),
      accounts: [],
      accountCount: accountDirectoryCount(providerRoot),
      models: [],
      modelsState: "not_supported",
      usageState: "not_supported",
      usageMeters: [],
    };
  }

  const installed = isInstalled(manifest, options);
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
  const configuredProvider = options.activeProviderId === providerId;
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
    enabled: true,
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

  const requestedAccount = options.activeAccountId;
  const active = candidates.find(
    (candidate) => candidate.account.accountId === requestedAccount,
  );
  if (
    providerId === options.activeProviderId &&
    active?.account.authentication === "authenticated" &&
    options.knownCompatibility?.[providerId] === "compatible"
  ) {
    active.account.control = "remote_control";
  }
  return { accounts: candidates.map((candidate) => candidate.account), total: names.length };
}

export function readProviderAccountProfiles(
  options: Pick<ProviderInventoryOptions, "registryRoot"> & {
    enabledOnly?: boolean;
  } = {},
): ProviderAccountProfile[] {
  const registryRoot = options.registryRoot ?? DEFAULT_PROVIDER_REGISTRY_ROOT;
  const providersRoot = join(registryRoot, "providers");
  if (!isDirectory(providersRoot)) return [];
  const profiles: ProviderAccountProfile[] = [];
  const identities = new Set<string>();
  const paths = new Set<string>();
  let providerDirectories: Dirent[];
  try {
    providerDirectories = readdirSync(providersRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const providerDirectory of providerDirectories) {
    if (!providerDirectory.isDirectory()) continue;
    const providerRoot = join(providersRoot, providerDirectory.name);
    const manifestPath = join(providerRoot, "provider.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: RawProviderManifest;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      manifest = parsed as RawProviderManifest;
    } catch {
      continue;
    }
    if (options.enabledOnly === true && manifest.enabled !== true) continue;
    const providerId =
      slug(asString(manifest.id) ?? providerDirectory.name) ??
      slug(providerDirectory.name);
    if (providerId === null) continue;
    const accountsRoot = join(providerRoot, "accounts");
    if (!isDirectory(accountsRoot)) continue;
    let accountDirectories: Dirent[];
    try {
      accountDirectories = readdirSync(accountsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const accountDirectory of accountDirectories
      .filter((entry) => entry.isDirectory())
      .slice(0, MAX_PROVIDER_ACCOUNTS)) {
      const profileFile = join(accountsRoot, accountDirectory.name, "profile.json");
      if (!existsSync(profileFile)) continue;
      let profile: RawAccountProfile;
      try {
        const parsed = JSON.parse(readFileSync(profileFile, "utf8")) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        profile = parsed as RawAccountProfile;
      } catch {
        continue;
      }
      const accountId =
        slug(asString(profile.id) ?? accountDirectory.name) ??
        slug(accountDirectory.name);
      const rawPath = asString(profile.profilePath);
      if (accountId === null || rawPath === null || !isAbsoluteLocal(rawPath)) {
        continue;
      }
      let profilePath: string;
      try {
        profilePath = realpathSync(rawPath);
      } catch {
        continue;
      }
      const identity = `${providerId}\u0000${accountId}`;
      const normalizedPath = profilePath.toLowerCase();
      if (identities.has(identity) || paths.has(normalizedPath)) {
        throw new Error("Duplicate provider account identity in terminal registry");
      }
      identities.add(identity);
      paths.add(normalizedPath);
      profiles.push({
        providerId,
        accountId,
        displayName:
          sanitizeText(asString(profile.displayName), 96) ?? accountId,
        profilePath,
      });
    }
  }
  return profiles.sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) ||
      left.accountId.localeCompare(right.accountId),
  );
}

function providerCapabilities(input: {
  observedAt: string;
  enabled: boolean;
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
    evidence(
      "installation_probe",
      input.enabled ? "supported" : "unknown",
      "terminal_registry",
      input.enabled ? null : "Provider is disabled; installation was not probed",
    ),
    evidence(
      "authentication_probe",
      input.enabled && input.loginProbe ? "supported" : "unknown",
      "terminal_registry",
      input.enabled
        ? input.loginProbe
          ? null
          : "Registry does not declare login detection"
        : "Provider is disabled; authentication was not probed",
    ),
    evidence(
      "usage_collection",
      input.usageSupported ? "unknown" : "unsupported",
      "terminal_registry",
      input.enabled
        ? input.usageSupported
          ? "Collector not executed"
          : "Collector not supported"
        : "Provider is disabled; usage collection was not run",
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

function accountDirectoryCount(providerRoot: string) {
  const accountsRoot = join(providerRoot, "accounts");
  if (!isDirectory(accountsRoot)) return 0;
  try {
    return readdirSync(accountsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, MAX_PROVIDER_ACCOUNTS).length;
  } catch {
    return 0;
  }
}

export function providerEnabled(
  providerId: string,
  options: Pick<ProviderInventoryOptions, "registryRoot"> = {},
) {
  const match = providerManifest(providerId, options.registryRoot);
  return match.manifest.enabled === true;
}

export function setProviderEnabled(input: {
  providerId: string;
  expectedEnabled: boolean;
  enabled: boolean;
  registryRoot?: string;
}) {
  if (input.expectedEnabled === input.enabled) {
    throw new ProviderEnablementMutationError(
      "PROVIDER_ENABLEMENT_CONFLICT",
      "Provider enablement mutation must change the current value",
    );
  }
  const match = providerManifest(input.providerId, input.registryRoot);
  const current = match.manifest.enabled === true;
  if (current !== input.expectedEnabled) {
    throw new ProviderEnablementMutationError(
      "PROVIDER_ENABLEMENT_CONFLICT",
      "Provider enablement changed since the inventory snapshot",
    );
  }
  const updated = { ...match.manifest, enabled: input.enabled };
  const temporaryPath = `${match.manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const mode = statSync(match.manifestPath).mode & 0o777;
  writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode,
  });
  try {
    renameSync(temporaryPath, match.manifestPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return { providerId: input.providerId, enabled: input.enabled };
}

function providerManifest(providerId: string, registryRoot?: string) {
  const root = registryRoot ?? DEFAULT_PROVIDER_REGISTRY_ROOT;
  const providersRoot = join(root, "providers");
  if (!isDirectory(providersRoot)) {
    throw new ProviderEnablementMutationError(
      "PROVIDER_REGISTRY_UNAVAILABLE",
      "Terminal provider registry is unavailable",
    );
  }
  let canonicalProvidersRoot: string;
  let directories: Dirent[];
  try {
    canonicalProvidersRoot = realpathSync(providersRoot);
    directories = readdirSync(canonicalProvidersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, MAX_PROVIDER_INVENTORY);
  } catch {
    throw new ProviderEnablementMutationError(
      "PROVIDER_REGISTRY_UNAVAILABLE",
      "Terminal provider registry could not be read",
    );
  }

  const matches: Array<{ manifestPath: string; manifest: RawProviderManifest & Record<string, unknown> }> = [];
  for (const directory of directories) {
    const candidatePath = join(canonicalProvidersRoot, directory.name, "provider.json");
    if (!existsSync(candidatePath)) continue;
    try {
      const manifestPath = realpathSync(candidatePath);
      const pathFromRoot = relative(canonicalProvidersRoot, manifestPath);
      if (
        pathFromRoot === "" ||
        pathFromRoot.startsWith("..") ||
        isAbsolute(pathFromRoot)
      ) {
        continue;
      }
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const manifest = parsed as RawProviderManifest & Record<string, unknown>;
      const candidateId =
        slug(asString(manifest.id) ?? directory.name) ?? slug(directory.name);
      if (candidateId === providerId) matches.push({ manifestPath, manifest });
    } catch {
      continue;
    }
  }
  if (matches.length !== 1) {
    throw new ProviderEnablementMutationError(
      matches.length === 0 ? "PROVIDER_NOT_FOUND" : "PROVIDER_MANIFEST_INVALID",
      matches.length === 0
        ? "Provider does not exist in the terminal registry"
        : "Provider identity is duplicated in the terminal registry",
    );
  }
  return matches[0]!;
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
