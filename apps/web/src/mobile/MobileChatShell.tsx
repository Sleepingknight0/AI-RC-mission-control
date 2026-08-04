import type {
  ProviderFleetSnapshot,
  ProviderModel,
  SessionCapabilitiesSnapshot,
  SessionSettings,
  SessionSettingsSnapshot,
} from "@aicl/protocol";
import { useEffect, useState, type FormEvent, type ReactNode, type RefObject } from "react";

import { AccountActivationSheet } from "./AccountActivationSheet.js";
import { AccountSessionDrawer } from "./AccountSessionDrawer.js";
import { MobileAccountHome } from "./MobileAccountHome.js";
import { MobileChatTimeline } from "./MobileChatTimeline.js";
import { MobileComposer } from "./MobileComposer.js";
import { MobileHeader } from "./MobileHeader.js";
import { MobileEvidenceSheet } from "./MobileEvidenceSheet.js";
import { ModelModeSheet } from "./ModelModeSheet.js";
import { SessionActionSheet } from "./SessionActionSheet.js";
import { SystemStatusSheet, type StatusFact } from "./SystemStatusSheet.js";
import type { AccountStatus, MobileSessionRow } from "./state.js";

export interface MobileChatShellProps {
  fleet: ProviderFleetSnapshot | null;
  providerId: string | null;
  accountId: string | null;
  providerLabel: string;
  accountLabel: string;
  accountStatus: AccountStatus;
  sessions: readonly MobileSessionRow[];
  selectedSessionId: string;
  sessionTitle: string | null;
  showAccountHome: boolean;
  search: string;
  sessionListLoading: boolean;
  sessionListHasMore: boolean;
  sessionListTruncated: boolean;
  now: number;
  canCreate: boolean;
  createDisabledReason: string | null;
  createForm: ReactNode;
  createRequest: number;
  statusLabel: string;
  statusTone: "ready" | "working" | "warning" | "offline";
  activityLabel: string;
  statusFacts: readonly StatusFact[];
  connectionNotice: string | null;
  authorityNotice: string | null;
  recoveryNotice: string | null;
  timelineBusy: boolean;
  timelineLoading: boolean;
  timelineEmpty: boolean;
  timelineRef: RefObject<HTMLDivElement | null>;
  unreadUpdates: number;
  timeline: ReactNode;
  approvals: ReactNode;
  evidenceOpen: boolean;
  evidenceTitle: string;
  evidenceDetail: string;
  evidence: ReactNode;
  prompt: string;
  modelLabel: string;
  modeLabel: string;
  canSubmit: boolean;
  composerReason: string;
  canAttachText: boolean;
  canAttachImage: boolean;
  attachmentChips: ReactNode;
  models: readonly ProviderModel[];
  modelEvidenceNotice: string | null;
  settings: SessionSettingsSnapshot | null;
  capabilities: SessionCapabilitiesSnapshot | null;
  onSelectAccount: (providerId: string, accountId: string) => void;
  onSearchChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onResumeNative: (providerSessionId: string) => void;
  onLoadMore: () => void;
  onCreate: () => void;
  activationPrompt: { actionLabel: string; busy: boolean } | null;
  onConfirmActivation: () => void;
  onCancelActivation: () => void;
  onRename: (session: MobileSessionRow, title: string) => void;
  onPin: (session: MobileSessionRow) => void;
  onArchive: (session: MobileSessionRow) => void;
  onResumeRuntime: (session: MobileSessionRow) => void;
  onTimelineScroll: () => void;
  onReturnToLive: () => void;
  onCloseEvidence: () => void;
  onPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onAbort: () => void;
  onPickFiles: (files: FileList) => void;
  onUpdateSettings: (settings: SessionSettings) => void;
}

export function MobileChatShell(props: MobileChatShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionSession, setActionSession] = useState<MobileSessionRow | null>(null);

  useEffect(() => {
    if (props.createRequest > 0) setCreateOpen(true);
  }, [props.createRequest]);

  useEffect(() => {
    if (!props.showAccountHome) setCreateOpen(false);
  }, [props.showAccountHome, props.selectedSessionId]);

  const closeAnd = (next: () => void) => {
    setDrawerOpen(false);
    window.requestAnimationFrame(next);
  };

  return (
    <div className="mobile-chat-shell">
      <a className="skip-link" href="#mobile-main">Skip to chat</a>
      <MobileHeader
        providerLabel={props.providerLabel}
        accountLabel={props.accountLabel}
        sessionTitle={props.showAccountHome ? null : props.sessionTitle}
        statusLabel={props.statusLabel}
        statusTone={props.statusTone}
        activityLabel={props.activityLabel}
        onOpenDrawer={() => setDrawerOpen(true)}
        onOpenStatus={() => setStatusOpen(true)}
      />
      {props.showAccountHome ? (
        <MobileAccountHome
          providerLabel={props.providerLabel}
          accountLabel={props.accountLabel}
          status={props.accountStatus}
          sessions={props.sessions}
          now={props.now}
          canCreate={props.canCreate}
          createDisabledReason={props.createDisabledReason}
          onOpenSession={props.onSelectSession}
          onResumeNative={props.onResumeNative}
          onOpenDrawer={() => setDrawerOpen(true)}
          onCreate={() => {
            props.onCreate();
          }}
        />
      ) : (
        <main className="mobile-chat-main" id="mobile-main" tabIndex={-1}>
          {props.connectionNotice !== null && (
            <section className="mobile-state-banner" role="status"><strong>Connection</strong><p>{props.connectionNotice}</p></section>
          )}
          {props.authorityNotice !== null && (
            <section className="mobile-state-banner" role="status"><strong>View only</strong><p>{props.authorityNotice}</p></section>
          )}
          {props.recoveryNotice !== null && (
            <section className="mobile-state-banner warning" role="alert"><strong>Operator review required</strong><p>{props.recoveryNotice}</p></section>
          )}
          <MobileChatTimeline
            busy={props.timelineBusy}
            loading={props.timelineLoading}
            empty={props.timelineEmpty}
            unreadUpdates={props.unreadUpdates}
            timelineRef={props.timelineRef}
            onScroll={props.onTimelineScroll}
            onReturnToLive={props.onReturnToLive}
          >
            {props.timeline}
          </MobileChatTimeline>
          {props.approvals}
          <MobileComposer
            value={props.prompt}
            modelLabel={props.modelLabel}
            modeLabel={props.modeLabel}
            busy={props.timelineBusy}
            canSubmit={props.canSubmit}
            disabledReason={props.composerReason}
            canAttachText={props.canAttachText}
            canAttachImage={props.canAttachImage}
            attachmentChips={props.attachmentChips}
            onChange={props.onPromptChange}
            onSubmit={props.onSubmit}
            onAbort={props.onAbort}
            onOpenModelMode={() => setModelOpen(true)}
            onPickFiles={props.onPickFiles}
          />
        </main>
      )}

      <AccountSessionDrawer
        open={drawerOpen}
        fleet={props.fleet}
        selectedProviderId={props.providerId}
        selectedAccountId={props.accountId}
        accountLabel={props.accountLabel}
        sessions={props.sessions}
        selectedSessionId={props.selectedSessionId}
        search={props.search}
        loading={props.sessionListLoading}
        hasMore={props.sessionListHasMore}
        truncated={props.sessionListTruncated}
        now={props.now}
        onClose={() => setDrawerOpen(false)}
        onSelectAccount={props.onSelectAccount}
        onSearchChange={props.onSearchChange}
        onSelectSession={(sessionId) => {
          props.onSelectSession(sessionId);
          setDrawerOpen(false);
        }}
        onResumeNative={(providerSessionId) => {
          props.onResumeNative(providerSessionId);
          setDrawerOpen(false);
        }}
        onOpenActions={(session) => closeAnd(() => setActionSession(session))}
        onLoadMore={props.onLoadMore}
        onOpenStatus={() => closeAnd(() => setStatusOpen(true))}
        approvalDestinationAvailable={!props.showAccountHome && props.approvals !== null}
        attachmentDestinationAvailable={!props.showAccountHome && (props.canAttachText || props.canAttachImage)}
        settingsDestinationAvailable={!props.showAccountHome && props.settings !== null}
        onOpenApprovals={() => closeAnd(() => {
          const approvals = document.querySelector<HTMLElement>(".mobile-approval-list");
          approvals?.scrollIntoView({ block: "nearest" });
          approvals?.focus({ preventScroll: true });
        })}
        onOpenAttachments={() => closeAnd(() => {
          document.querySelector<HTMLButtonElement>("[data-testid=mobile-attachment-trigger]")?.click();
        })}
        onOpenSettings={() => closeAnd(() => setModelOpen(true))}
      />
      <SystemStatusSheet open={statusOpen} facts={props.statusFacts} onClose={() => setStatusOpen(false)} />
      <MobileEvidenceSheet
        open={props.evidenceOpen}
        title={props.evidenceTitle}
        detail={props.evidenceDetail}
        onClose={props.onCloseEvidence}
      >
        {props.evidence}
      </MobileEvidenceSheet>
      <ModelModeSheet
        open={modelOpen}
        models={props.models}
        settings={props.settings}
        capabilities={props.capabilities}
        evidenceNotice={props.modelEvidenceNotice}
        onClose={() => setModelOpen(false)}
        onUpdate={props.onUpdateSettings}
      />
      <SessionActionSheet
        open={actionSession !== null}
        session={actionSession}
        onClose={() => setActionSession(null)}
        onRename={props.onRename}
        onPin={props.onPin}
        onArchive={props.onArchive}
        onResumeRuntime={props.onResumeRuntime}
      />
      <SessionActionSheet
        open={createOpen}
        session={null}
        onClose={() => setCreateOpen(false)}
        onRename={() => undefined}
        onPin={() => undefined}
        onArchive={() => undefined}
      >
        <div className="mobile-create-form">{props.createForm}</div>
      </SessionActionSheet>
      <AccountActivationSheet
        open={props.activationPrompt !== null}
        providerLabel={props.providerLabel}
        accountLabel={props.accountLabel}
        actionLabel={props.activationPrompt?.actionLabel ?? "Continue"}
        busy={props.activationPrompt?.busy ?? false}
        onClose={props.onCancelActivation}
        onConfirm={props.onConfirmActivation}
      />
    </div>
  );
}
