import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderFleetSnapshotSchema } from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_REGISTRY_ROOT,
  readProviderAccountProfiles,
  readProviderFleet,
} from "../src/provider-inventory.js";

const roots: string[] = [];
const now = () => new Date("2026-08-03T04:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function registry() {
  const root = mkdtempSync(join(tmpdir(), "aicl-provider-registry-"));
  roots.push(root);
  const providers = join(root, "providers");
  mkdirSync(providers);
  return { root, providers };
}

function provider(
  providers: string,
  directory: string,
  manifest: Record<string, unknown>,
) {
  const root = join(providers, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "provider.json"), JSON.stringify(manifest));
  return root;
}

function account(
  providerRoot: string,
  directory: string,
  profile: Record<string, unknown>,
) {
  const root = join(providerRoot, "accounts", directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "profile.json"), JSON.stringify(profile));
}

const codexManifest = {
  id: "codex",
  displayName: "OpenAI Codex",
  enabled: true,
  commandCandidates: ["codex.exe"],
  loginDetection: { relativePaths: ["auth.json"] },
  usage: { enabled: true, strategy: "officialCliJson" },
};

describe("terminal provider inventory", () => {
  it("reports an absent registry without fabricating providers", () => {
    const root = join(tmpdir(), `missing-${crypto.randomUUID()}`);
    const snapshot = readProviderFleet({ registryRoot: root, now });

    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.providers).toEqual([]);
  });

  it("keeps providers and accounts distinct without emitting paths or secrets", () => {
    const { root, providers } = registry();
    const providerRoot = provider(providers, "codex", codexManifest);
    const profileRoot = mkdtempSync(join(tmpdir(), "aicl-provider-profile-"));
    roots.push(profileRoot);
    writeFileSync(join(profileRoot, "auth.json"), "credential-canary");
    account(providerRoot, "blue", {
      id: "blue",
      displayName: "Blue Account",
      profilePath: profileRoot,
      lastUsedAt: "2026-08-03T03:00:00.000Z",
    });
    account(providerRoot, "green", {
      id: "green",
      displayName: "Green Account",
      profilePath: join(profileRoot, "missing"),
    });
    const bin = mkdtempSync(join(tmpdir(), "aicl-provider-bin-"));
    roots.push(bin);
    writeFileSync(join(bin, "codex.exe"), "");

    const snapshot = readProviderFleet({
      registryRoot: root,
      now,
      pathValue: bin,
      pathExtValue: ".EXE",
      activeProviderId: "codex",
      activeAccountId: "blue",
      knownVersions: { codex: "0.146.0" },
      knownCompatibility: { codex: "compatible" },
    });
    const entry = snapshot.providers[0];
    expect(entry?.accounts.map((item) => item.accountId)).toEqual([
      "blue",
      "green",
    ]);
    expect(entry?.accounts[0]?.control).toBe("remote_control");
    expect(entry?.adapterSupport).toBe("remote_control");
    expect(entry?.modelsState).toBe("unavailable");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(profileRoot);
    expect(serialized).not.toContain("auth.json");
    expect(serialized).not.toContain("credential-canary");
  });

  it("exposes three exact Codex profiles and never falls back to a default account", () => {
    const { root, providers } = registry();
    const providerRoot = provider(providers, "codex", codexManifest);
    for (const accountId of ["blue", "green", "violet"]) {
      const profileRoot = mkdtempSync(join(tmpdir(), `aicl-${accountId}-profile-`));
      roots.push(profileRoot);
      writeFileSync(join(profileRoot, "auth.json"), "sanitized-test-auth");
      account(providerRoot, accountId, {
        id: accountId,
        displayName: `${accountId} account`,
        profilePath: profileRoot,
      });
    }
    const bin = mkdtempSync(join(tmpdir(), "aicl-provider-bin-"));
    roots.push(bin);
    writeFileSync(join(bin, "codex.exe"), "");

    const profiles = readProviderAccountProfiles({ registryRoot: root });
    expect(profiles.map(({ providerId, accountId }) => ({ providerId, accountId })))
      .toEqual([
        { providerId: "codex", accountId: "blue" },
        { providerId: "codex", accountId: "green" },
        { providerId: "codex", accountId: "violet" },
      ]);

    const snapshot = readProviderFleet({
      registryRoot: root,
      now,
      pathValue: bin,
      pathExtValue: ".EXE",
      activeProviderId: "codex",
      activeAccountId: "missing-account",
      knownCompatibility: { codex: "compatible" },
    });
    expect(snapshot.providers[0]?.accounts).toHaveLength(3);
    expect(snapshot.providers[0]?.accounts.every(
      (entry) => entry.control === "inventory_only",
    )).toBe(true);
    expect(snapshot.providers[0]?.adapterSupport).toBe("inventory_only");
  });

  it("isolates malformed profile manifests and unreadable account roots", () => {
    const { root, providers } = registry();
    const brokenManifest = join(providers, "broken-manifest");
    mkdirSync(brokenManifest);
    writeFileSync(join(brokenManifest, "provider.json"), "{");

    const brokenAccounts = provider(providers, "broken-accounts", {
      ...codexManifest,
      id: "broken-accounts",
    });
    writeFileSync(join(brokenAccounts, "accounts"), "not-a-directory");

    const validProvider = provider(providers, "codex", codexManifest);
    const malformedAccount = join(validProvider, "accounts", "malformed");
    mkdirSync(malformedAccount, { recursive: true });
    writeFileSync(join(malformedAccount, "profile.json"), "[");
    const profileRoot = mkdtempSync(join(tmpdir(), "aicl-valid-profile-"));
    roots.push(profileRoot);
    account(validProvider, "valid", {
      id: "valid",
      displayName: "Valid account",
      profilePath: profileRoot,
    });

    expect(readProviderAccountProfiles({ registryRoot: root })).toEqual([
      expect.objectContaining({ providerId: "codex", accountId: "valid" }),
    ]);
  });

  it("fails closed when two account records resolve to the same profile path", () => {
    const { root, providers } = registry();
    const providerRoot = provider(providers, "codex", codexManifest);
    const profileRoot = mkdtempSync(join(tmpdir(), "aicl-shared-profile-"));
    roots.push(profileRoot);
    account(providerRoot, "blue", {
      id: "blue",
      displayName: "Blue",
      profilePath: profileRoot,
    });
    account(providerRoot, "green", {
      id: "green",
      displayName: "Green",
      profilePath: profileRoot,
    });

    expect(() => readProviderAccountProfiles({ registryRoot: root })).toThrow(
      "Duplicate provider account identity",
    );
  });

  it("never grants remote control to a non-Codex provider", () => {
    const { root, providers } = registry();
    provider(providers, "grok", {
      ...codexManifest,
      id: "grok",
      displayName: "Grok",
    });
    const snapshot = readProviderFleet({
      registryRoot: root,
      now,
      activeProviderId: "grok",
      knownCompatibility: { grok: "compatible" },
    });
    expect(snapshot.providers[0]?.adapterSupport).toBe("inventory_only");
  });

  it("isolates malformed manifests and deterministic duplicate IDs", () => {
    const { root, providers } = registry();
    provider(providers, "a", { ...codexManifest, id: "same" });
    provider(providers, "b", { ...codexManifest, id: "same" });
    const broken = join(providers, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "provider.json"), "{");

    const snapshot = readProviderFleet({ registryRoot: root, now });
    expect(snapshot.providers.map((entry) => entry.providerId)).toEqual([
      "same",
      "broken",
    ]);
    expect(snapshot.providers[1]?.installation).toBe("error");
    expect(snapshot.degraded).toBe(true);
  });

  it("strips control sequences and bounds untrusted labels", () => {
    const { root, providers } = registry();
    provider(providers, "codex", {
      ...codexManifest,
      displayName: `\u001b[31m${"L".repeat(150)}\u0007`,
    });
    const entry = readProviderFleet({ registryRoot: root, now }).providers[0];
    expect(entry?.displayName.length).toBeLessThanOrEqual(96);
    expect(JSON.stringify(entry)).not.toContain("\u001b");
    expect(() => ProviderFleetSnapshotSchema.parse(
      readProviderFleet({ registryRoot: root, now }),
    )).not.toThrow();
  });

  it("does not follow login detection traversal", () => {
    const { root, providers } = registry();
    const providerRoot = provider(providers, "codex", {
      ...codexManifest,
      loginDetection: { relativePaths: ["..\\secret.txt"] },
    });
    account(providerRoot, "account", {
      profilePath: root,
    });
    writeFileSync(join(root, "secret.txt"), "canary");

    const entry = readProviderFleet({ registryRoot: root, now }).providers[0];
    expect(entry?.accounts[0]?.authentication).toBe("unknown");
  });
});

describe("operator registry", () => {
  const available = (() => {
    try {
      return readProviderFleet().source === "terminal_registry";
    } catch {
      return false;
    }
  })();

  it.skipIf(!available)("parses the real registry without path leakage", () => {
    const snapshot = readProviderFleet();
    expect(snapshot.providers.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain(DEFAULT_PROVIDER_REGISTRY_ROOT);
  });
});
