import type { ProviderAccount } from "@aicl/protocol";
import { useEffect, useState } from "react";

import { ChevronIcon } from "./icons.js";
import { groupAccountsByProvider, providerAccountKey } from "./state.js";
import type { ProviderFleetSnapshot } from "@aicl/protocol";

function accountState(account: ProviderAccount) {
  if (account.authentication !== "authenticated") return account.authentication.replaceAll("_", " ");
  return account.control === "remote_control" ? "Remote control" : "Inventory only";
}

export function ProviderAccountTree({
  fleet,
  selectedProviderId,
  selectedAccountId,
  onSelectAccount,
}: {
  fleet: ProviderFleetSnapshot | null;
  selectedProviderId: string | null;
  selectedAccountId: string | null;
  onSelectAccount: (providerId: string, accountId: string) => void;
}) {
  const groups = groupAccountsByProvider(fleet);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(selectedProviderId === null ? [] : [selectedProviderId]),
  );

  useEffect(() => {
    if (selectedProviderId === null) return;
    setExpanded((current) => {
      if (current.has(selectedProviderId)) return current;
      return new Set(current).add(selectedProviderId);
    });
  }, [selectedProviderId]);

  if (groups.length === 0) {
    return <p className="mobile-empty">No provider accounts are available.</p>;
  }

  return (
    <div className="mobile-provider-tree" data-testid="mobile-provider-tree">
      {groups.map(({ provider, accounts }) => {
        const isExpanded = expanded.has(provider.providerId);
        return (
          <section key={provider.providerId}>
            <button
              type="button"
              className="mobile-provider-row"
              aria-expanded={isExpanded}
              aria-controls={`mobile-accounts-${provider.providerId}`}
              onClick={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(provider.providerId)) next.delete(provider.providerId);
                else next.add(provider.providerId);
                return next;
              })}
            >
              <span className="mobile-provider-mark" aria-hidden="true">
                {provider.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="mobile-row-copy">
                <strong>{provider.displayName}</strong>
                <small>{provider.freshness}</small>
              </span>
              <span className="mobile-count">{accounts.length}</span>
              <ChevronIcon expanded={isExpanded} />
            </button>
            <div id={`mobile-accounts-${provider.providerId}`} hidden={!isExpanded}>
              {accounts.length === 0 ? (
                <p className="mobile-empty compact">No accounts reported.</p>
              ) : accounts.map((account) => {
                const selected =
                  provider.providerId === selectedProviderId &&
                  account.accountId === selectedAccountId;
                const key = providerAccountKey(provider.providerId, account.accountId);
                return (
                  <div className="mobile-account-row" key={key}>
                    <button
                      type="button"
                      className="mobile-account-select"
                      data-testid={`mobile-account-${provider.providerId}-${account.accountId}`}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => onSelectAccount(provider.providerId, account.accountId)}
                    >
                      <span
                        className="mobile-account-dot"
                        data-control={account.control}
                        data-auth={account.authentication}
                        aria-hidden="true"
                      />
                      <span className="mobile-row-copy">
                        <strong title={account.displayName}>{account.displayName}</strong>
                        <small>{accountState(account)}</small>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
