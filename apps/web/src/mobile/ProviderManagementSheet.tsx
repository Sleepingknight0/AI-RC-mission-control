import type { ProviderFleetSnapshot, ProviderRecord } from "@aicl/protocol";

import { MobileOverlay, MobileOverlayHeading } from "./MobileOverlay.js";

export function ProviderManagementSheet({
  open,
  fleet,
  pendingProviderIds,
  onClose,
  onSetEnabled,
}: {
  open: boolean;
  fleet: ProviderFleetSnapshot | null;
  pendingProviderIds: ReadonlySet<string>;
  onClose: () => void;
  onSetEnabled: (provider: ProviderRecord, enabled: boolean) => void;
}) {
  const providers = [...(fleet?.providers ?? [])].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  const active = providers.filter((provider) => provider.enabled);
  const available = providers.filter((provider) => !provider.enabled);

  return (
    <MobileOverlay
      open={open}
      variant="sheet"
      title="Manage providers"
      testId="mobile-provider-management"
      onClose={onClose}
    >
      <MobileOverlayHeading
        title="Manage providers"
        detail="Choose which providers appear in AI Accounts"
        onClose={onClose}
      />
      <div className="mobile-sheet-scroll mobile-provider-management">
        <ProviderSection
          title="Active"
          empty="No providers are active."
          providers={active}
          pendingProviderIds={pendingProviderIds}
          onSetEnabled={onSetEnabled}
        />
        <ProviderSection
          title="Available / disabled"
          empty="No additional providers were discovered."
          providers={available}
          pendingProviderIds={pendingProviderIds}
          onSetEnabled={onSetEnabled}
        />
        <p className="mobile-provider-management-note">
          Enabling changes visibility only. Installation, authentication, account,
          compatibility, and Session capability checks still apply.
        </p>
      </div>
    </MobileOverlay>
  );
}

function ProviderSection({
  title,
  empty,
  providers,
  pendingProviderIds,
  onSetEnabled,
}: {
  title: string;
  empty: string;
  providers: readonly ProviderRecord[];
  pendingProviderIds: ReadonlySet<string>;
  onSetEnabled: (provider: ProviderRecord, enabled: boolean) => void;
}) {
  return (
    <section className="mobile-provider-management-section">
      <h3>{title}</h3>
      {providers.length === 0 ? (
        <p className="mobile-empty">{empty}</p>
      ) : (
        <ul>
          {providers.map((provider) => {
            const pending = pendingProviderIds.has(provider.providerId);
            const runtimeActive = provider.accounts.some(
              (account) => account.control === "remote_control",
            );
            const blocked = pending || (provider.enabled && runtimeActive);
            const nextEnabled = !provider.enabled;
            const action = nextEnabled ? "Enable" : "Disable";
            const reason = runtimeActive
              ? "Deactivate the active provider account before disabling it"
              : `${action} ${provider.displayName}`;
            return (
              <li key={provider.providerId} data-provider-id={provider.providerId}>
                <span className="mobile-provider-mark" aria-hidden="true">
                  {provider.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="mobile-row-copy">
                  <strong>{provider.displayName}</strong>
                  <small>{providerSummary(provider)}</small>
                </span>
                <button
                  type="button"
                  role="switch"
                  className="mobile-provider-switch"
                  aria-checked={provider.enabled}
                  aria-label={`${action} ${provider.displayName}`}
                  data-testid={`provider-toggle-${provider.providerId}`}
                  disabled={blocked}
                  title={pending ? `Updating ${provider.displayName}` : reason}
                  onClick={() => onSetEnabled(provider, nextEnabled)}
                >
                  <span aria-hidden="true" />
                  <b>{pending ? "Saving" : provider.enabled ? "On" : "Off"}</b>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function providerSummary(provider: ProviderRecord) {
  if (!provider.enabled) {
    const accounts = provider.accountCount === 1 ? "1 stored account" : `${provider.accountCount} stored accounts`;
    return `Disabled · ${accounts}`;
  }
  const installation = provider.installation === "installed"
    ? "Installed"
    : provider.installation === "not_installed"
      ? "Not installed"
      : "Inventory unavailable";
  const authority = provider.adapterSupport === "remote_control"
    ? "Remote control"
    : "Inventory only";
  return `${installation} · ${authority}`;
}
