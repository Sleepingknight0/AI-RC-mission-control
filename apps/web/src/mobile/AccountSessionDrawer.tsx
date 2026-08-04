import type { ProviderFleetSnapshot } from "@aicl/protocol";

import { AccountSessionList } from "./AccountSessionList.js";
import { MobileOverlay, MobileOverlayHeading } from "./MobileOverlay.js";
import { ProviderAccountTree } from "./ProviderAccountTree.js";
import type { MobileSessionRow } from "./state.js";

export function AccountSessionDrawer({
  open,
  fleet,
  selectedProviderId,
  selectedAccountId,
  accountLabel,
  sessions,
  selectedSessionId,
  search,
  loading,
  hasMore,
  truncated,
  now,
  onClose,
  onSelectAccount,
  onSearchChange,
  onSelectSession,
  onResumeNative,
  onOpenActions,
  onLoadMore,
  onOpenStatus,
  approvalDestinationAvailable,
  attachmentDestinationAvailable,
  settingsDestinationAvailable,
  onOpenApprovals,
  onOpenAttachments,
  onOpenSettings,
}: {
  open: boolean;
  fleet: ProviderFleetSnapshot | null;
  selectedProviderId: string | null;
  selectedAccountId: string | null;
  accountLabel: string;
  sessions: readonly MobileSessionRow[];
  selectedSessionId: string;
  search: string;
  loading: boolean;
  hasMore: boolean;
  truncated: boolean;
  now: number;
  onClose: () => void;
  onSelectAccount: (providerId: string, accountId: string) => void;
  onSearchChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onResumeNative: (providerSessionId: string) => void;
  onOpenActions: (session: MobileSessionRow) => void;
  onLoadMore: () => void;
  onOpenStatus: () => void;
  approvalDestinationAvailable: boolean;
  attachmentDestinationAvailable: boolean;
  settingsDestinationAvailable: boolean;
  onOpenApprovals: () => void;
  onOpenAttachments: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <MobileOverlay open={open} variant="drawer" title="Accounts and Sessions" testId="mobile-account-drawer" onClose={onClose}>
      <MobileOverlayHeading title="Accounts" detail="Provider → Account → Session" onClose={onClose} />
      <div className="mobile-drawer-scroll">
        <ProviderAccountTree
          fleet={fleet}
          selectedProviderId={selectedProviderId}
          selectedAccountId={selectedAccountId}
          onSelectAccount={onSelectAccount}
        />
        <div className="mobile-drawer-section-heading">
          <h2>Sessions</h2>
          <span title={accountLabel}>{accountLabel}</span>
        </div>
        <AccountSessionList
          sessions={sessions}
          search={search}
          loading={loading}
          hasMore={hasMore}
          truncated={truncated}
          now={now}
          selectedSessionId={selectedSessionId}
          onSearchChange={onSearchChange}
          onSelectSession={onSelectSession}
          onResumeNative={onResumeNative}
          onOpenActions={onOpenActions}
          onLoadMore={onLoadMore}
        />
        <nav className="mobile-system-nav" aria-label="System and Settings">
          <h2>System</h2>
          <button type="button" onClick={onOpenStatus}>Status</button>
          <button
            type="button"
            disabled={!approvalDestinationAvailable}
            title={approvalDestinationAvailable ? "Open pending approvals" : "No pending approvals"}
            onClick={onOpenApprovals}
          >Approvals</button>
          <button
            type="button"
            disabled={!attachmentDestinationAvailable}
            title={attachmentDestinationAvailable ? "Open attachment actions" : "Attachments unavailable for this Session"}
            onClick={onOpenAttachments}
          >Attachments</button>
          <button
            type="button"
            disabled={!settingsDestinationAvailable}
            title={settingsDestinationAvailable ? "Open Session settings" : "Session settings unavailable"}
            onClick={onOpenSettings}
          >Settings</button>
        </nav>
      </div>
    </MobileOverlay>
  );
}
