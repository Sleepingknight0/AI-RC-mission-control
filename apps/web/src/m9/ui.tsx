import { SessionOperationalStateSchema } from "@aicl/protocol";
import type {
  ApprovalLeaseSnapshot,
  InputAttachment,
  ProviderFleetSnapshot,
  SessionCapabilitiesSnapshot,
  SessionCatalogFilter,
  SessionSettings,
  SessionSummaryV2,
} from "@aicl/protocol";
import { useEffect, useState, type FormEvent } from "react";

import {
  activeLease,
  capabilitySupported,
  controllableProviders,
  leaseRemainingMs,
  sessionSupportRow,
  type AttachmentUiState,
  type CatalogState,
  type FleetState,
  type NativeState,
  type ResourceFreshness,
  type SessionCapabilitiesUiState,
  type SettingsUiState,
} from "./state.js";

function FreshnessBadge({ status }: { status: ResourceFreshness }) {
  return <span className={`freshness-badge freshness-${status}`}>{status}</span>;
}

function DisabledReason({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return <p className="control-reason">{reason}</p>;
}

export function ProviderFleetPanel({
  fleet,
  onRefresh,
  selectedProviderId,
  selectedAccountId,
  onSelectProvider,
  onSelectAccount,
}: {
  fleet: FleetState;
  onRefresh: () => void;
  selectedProviderId: string | null;
  selectedAccountId: string | null;
  onSelectProvider: (providerId: string) => void;
  onSelectAccount: (accountId: string) => void;
}) {
  const snapshot = fleet.snapshot;
  const providers = snapshot?.providers ?? [];
  return (
    <section className="m9-panel fleet-panel" aria-labelledby="fleet-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PROVIDER FLEET</p>
          <h2 id="fleet-title">Inventory</h2>
        </div>
        <div className="panel-heading-actions">
          <FreshnessBadge status={fleet.status} />
          <button type="button" className="secondary-button" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>
      {fleet.error && <p className="inline-error" role="alert">{fleet.error}</p>}
      {snapshot?.notice && <p className="panel-notice">{snapshot.notice}</p>}
      {providers.length === 0 ? (
        <p className="empty-state">
          {fleet.status === "loading"
            ? "Loading provider inventory…"
            : "No providers reported by Core."}
        </p>
      ) : (
        <ul className="fleet-list">
          {providers.map((provider) => {
            const remote = capabilitySupported(provider, "remote_control");
            const selected = provider.providerId === selectedProviderId;
            return (
              <li key={provider.providerId}>
                <button
                  type="button"
                  className={`fleet-card${selected ? " selected" : ""}`}
                  onClick={() => onSelectProvider(provider.providerId)}
                >
                  <span className="fleet-card-top">
                    <strong title={provider.displayName}>{provider.displayName}</strong>
                    <span className="mono-meta">{provider.adapterSupport.replaceAll("_", " ")}</span>
                  </span>
                  <span className="fleet-card-meta">
                    <span>{provider.installation}</span>
                    <span>{provider.authentication}</span>
                    <span>{provider.freshness}</span>
                  </span>
                  {!remote.ok && (
                    <span className="control-reason">{remote.reason}</span>
                  )}
                  {provider.usageMeters.length > 0 && (
                    <span className="usage-meters">
                      {provider.usageMeters.map((meter) => (
                        <span key={meter.meterId} title={meter.detail ?? undefined}>
                          {meter.displayName}:{" "}
                          {meter.state === "available" && meter.remainingPercent !== null
                            ? `${meter.remainingPercent.toFixed(0)}%`
                            : meter.state}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
                {selected && provider.accounts.length > 0 && (
                  <div className="account-row">
                    <label className="field-label" htmlFor="account-select">
                      Account
                    </label>
                    <select
                      id="account-select"
                      value={selectedAccountId ?? ""}
                      onChange={(event) => onSelectAccount(event.target.value)}
                    >
                      {provider.accounts.map((account) => (
                        <option key={account.accountId} value={account.accountId}>
                          {account.displayName}
                          {account.control === "inventory_only" ? " (inventory only)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SessionCatalogPanel({
  catalog,
  native,
  selectedSessionId,
  onSelectSession,
  onFiltersChange,
  onLoadMore,
  onCreate,
  onResumeNative,
  onRename,
  onPin,
  onArchive,
  onRefreshNative,
  createDisabledReason,
  providerOptions,
  accountOptions,
  selectedProviderId,
  selectedAccountId,
}: {
  catalog: CatalogState;
  native: NativeState;
  selectedSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onFiltersChange: (patch: Partial<SessionCatalogFilter>) => void;
  onLoadMore: () => void;
  onCreate: () => void;
  onResumeNative: (providerSessionId: string) => void;
  onRename: (session: SessionSummaryV2, title: string) => void;
  onPin: (session: SessionSummaryV2) => void;
  onArchive: (session: SessionSummaryV2) => void;
  onRefreshNative: () => void;
  createDisabledReason: string | null;
  providerOptions: Array<{ id: string; label: string }>;
  accountOptions: Array<{ id: string; label: string }>;
  selectedProviderId: string | null;
  selectedAccountId: string | null;
}) {
  const filters = catalog.filters;
  const nativeIsCurrent =
    native.status === "ready" &&
    ((native.page?.freshness === "live" &&
      native.page.providerId === selectedProviderId &&
      native.page.accountId === selectedAccountId) ||
      (native.snapshot?.freshness === "live" &&
        native.snapshot.providerId === selectedProviderId &&
        native.snapshot.accountId === selectedAccountId));
  return (
    <section className="m9-panel catalog-panel" aria-labelledby="catalog-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SESSION CATALOG V2</p>
          <h2 id="catalog-title">Sessions</h2>
        </div>
        <FreshnessBadge status={catalog.status} />
      </div>
      <div className="catalog-toolbar">
        <label className="field-label" htmlFor="catalog-search">
          Search
        </label>
        <input
          id="catalog-search"
          defaultValue={filters.search ?? ""}
          placeholder="Title, provider, project…"
          onChange={(event) => {
            const value = event.target.value.trim();
            onFiltersChange({ search: value === "" ? null : value });
          }}
        />
        <label className="field-label" htmlFor="catalog-provider">
          Provider
        </label>
        <select
          id="catalog-provider"
          value={filters.providerIds[0] ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onFiltersChange({
              providerIds: value === "" ? [] : [value],
            });
          }}
        >
          <option value="">All providers</option>
          {providerOptions.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor="catalog-account">
          Account
        </label>
        <select
          id="catalog-account"
          value={filters.accountIds[0] ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onFiltersChange({
              accountIds: value === "" ? [] : [value],
            });
          }}
        >
          <option value="">All accounts</option>
          {accountOptions.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor="catalog-archived">
          Archive
        </label>
        <select
          id="catalog-archived"
          value={filters.archived}
          onChange={(event) =>
            onFiltersChange({
              archived: event.target.value as SessionCatalogFilter["archived"],
            })
          }
        >
          <option value="exclude">Hide archived</option>
          <option value="include">Include archived</option>
          <option value="only">Archived only</option>
        </select>
        <label className="field-label" htmlFor="catalog-pinned">
          Pinned
        </label>
        <select
          id="catalog-pinned"
          value={filters.pinned === null ? "any" : filters.pinned ? "yes" : "no"}
          onChange={(event) => {
            const value = event.target.value;
            onFiltersChange({
              pinned: value === "any" ? null : value === "yes",
            });
          }}
        >
          <option value="any">Any</option>
          <option value="yes">Pinned only</option>
          <option value="no">Unpinned only</option>
        </select>
        <label className="field-label" htmlFor="catalog-project">
          Project
        </label>
        <input
          id="catalog-project"
          defaultValue={filters.project ?? ""}
          placeholder="Project label or path…"
          onChange={(event) => {
            const value = event.target.value.trim();
            onFiltersChange({ project: value === "" ? null : value });
          }}
        />
        <fieldset className="catalog-state-filter">
          <legend>State</legend>
          <div className="catalog-state-chips">
            {SessionOperationalStateSchema.options.map((state) => {
              const selected = filters.states.includes(state);
              return (
                <button
                  key={state}
                  type="button"
                  className="text-button catalog-filter-chip"
                  aria-pressed={selected}
                  onClick={() =>
                    onFiltersChange({
                      states: selected
                        ? filters.states.filter((item) => item !== state)
                        : [...filters.states, state],
                    })
                  }
                >
                  {state.replaceAll("_", " ")}
                </button>
              );
            })}
          </div>
        </fieldset>
        <button
          type="button"
          disabled={createDisabledReason !== null}
          title={createDisabledReason ?? "Create Session"}
          onClick={onCreate}
        >
          New Session
        </button>
        <DisabledReason reason={createDisabledReason} />
      </div>
      {catalog.error && <p className="inline-error" role="alert">{catalog.error}</p>}
      {catalog.notice && <p className="panel-notice" role="status">{catalog.notice}</p>}
      <p className="mono-meta catalog-count">
        Showing {catalog.sessions.length} of {catalog.total}
        {catalog.pendingAppend ? " · loading page…" : ""}
        {catalog.needsFreshPage ? " · recovering first page…" : ""}
      </p>
      <div className="catalog-list">
        {catalog.sessions.length === 0 ? (
          <p className="empty-state">
            {catalog.status === "loading" ? "Loading catalog…" : "No AICL Sessions match filters."}
          </p>
        ) : (
          catalog.sessions.map((session) => (
            <article
              key={session.sessionId}
              className={`catalog-row${session.sessionId === selectedSessionId ? " selected" : ""}`}
            >
              <button
                type="button"
                className="catalog-row-main"
                onClick={() => onSelectSession(session.sessionId)}
              >
                <span className="catalog-row-top">
                  <strong title={session.title}>{session.title}</strong>
                  <span className="mono-meta">{session.state}</span>
                </span>
                <span className="catalog-row-meta" title={session.projectPath ?? undefined}>
                  {session.source === "imported" ? "imported · " : ""}
                  {session.providerId}
                  {session.accountId ? ` · ${session.accountId}` : ""}
                  {session.projectName ? ` · ${session.projectName}` : ""}
                </span>
                <span className="catalog-row-flags">
                  <span>bind {session.providerBindingStatus}</span>
                  <span>{session.canControl ? "controllable" : "read-only"}</span>
                  {session.pinned && <span>pinned</span>}
                  {session.archived && <span>archived</span>}
                </span>
              </button>
              <div className="catalog-row-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const next = window.prompt("Rename Session", session.title);
                    if (next !== null) onRename(session, next);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onPin(session)}
                >
                  {session.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={session.state === "running"}
                  onClick={() => onArchive(session)}
                >
                  {session.archived ? "Unarchive" : "Archive"}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
      {catalog.nextCursor && (
        <button
          type="button"
          className="secondary-button"
          disabled={catalog.pendingAppend}
          onClick={onLoadMore}
        >
          Load more ({catalog.total} total)
        </button>
      )}

      <div className="native-block">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">PROVIDER-NATIVE</p>
            <h3>Discovered Sessions</h3>
          </div>
          <button type="button" className="secondary-button" onClick={onRefreshNative}>
            Refresh native
          </button>
        </div>
        <FreshnessBadge status={native.status} />
        {(native.page?.notice ?? native.snapshot?.notice) && <p className="panel-notice">{native.page?.notice ?? native.snapshot?.notice}</p>}
        {native.sessions.length === 0 ? (
          <p className="empty-state">No native Sessions in current snapshot.</p>
        ) : (
          <ul className="native-list">
            {native.sessions.map((session) => (
              <li key={session.providerSessionId}>
                <span title={session.title}>{session.title}</span>
                <span className="mono-meta" title={session.projectPath}>
                  {session.projectName}
                </span>
                <span className="mono-meta">{session.providerStatus}</span>
                <button
                  type="button"
                  className="text-button"
                  disabled={!nativeIsCurrent || !session.canResume}
                  title={
                    nativeIsCurrent && session.canResume
                      ? "Import/resume into a new AICL Session"
                      : "Resume requires a current live snapshot for this provider/account"
                  }
                  onClick={() => onResumeNative(session.providerSessionId)}
                >
                  Resume
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function SessionControlsPanel({
  settings,
  sessionCapabilities,
  fleet,
  lease,
  runtimeId,
  runtimeGeneration,
  now,
  onUpdateSettings,
  onCreateLease,
  onRevokeLease,
  onEmergencyStop,
}: {
  settings: SettingsUiState;
  sessionCapabilities: SessionCapabilitiesUiState;
  fleet: ProviderFleetSnapshot | null;
  lease: ApprovalLeaseSnapshot | null;
  runtimeId: string | null;
  runtimeGeneration: number | null;
  now: number;
  onUpdateSettings: (settings: SessionSettings) => void;
  onCreateLease: (minutes: 15 | 30 | 60) => void;
  onRevokeLease: () => void;
  onEmergencyStop: () => void;
}) {
  const snapshot = settings.snapshot;
  const caps: SessionCapabilitiesSnapshot | null =
    sessionCapabilities.snapshot?.settingsRevision === snapshot?.revision
      ? sessionCapabilities.snapshot
      : null;
  const provider =
    fleet?.providers.find((item) => item.providerId === snapshot?.settings.providerId) ??
    null;
  // Models are inventory display only; enablement comes from Session projection.
  const models = provider?.models.filter((model) => !model.hidden) ?? [];
  const controlCap = sessionSupportRow(caps, { type: "control" });
  const modelCap = sessionSupportRow(caps, { type: "model" });
  // Reasoning options still need fleet model rows for labels; gate on model support.
  const reasonCap = modelCap;
  const execCapAsk = sessionSupportRow(caps, { type: "execution", mode: "ask" });
  const execCapPlan = sessionSupportRow(caps, { type: "execution", mode: "plan" });
  const execCapAuto = sessionSupportRow(caps, { type: "execution", mode: "auto" });
  const approvalRows = {
    review: sessionSupportRow(caps, { type: "approval", policy: "review" }),
    balanced: sessionSupportRow(caps, { type: "approval", policy: "balanced" }),
    workspace_auto: sessionSupportRow(caps, {
      type: "approval",
      policy: "workspace_auto",
    }),
    full_auto_lease: sessionSupportRow(caps, {
      type: "approval",
      policy: "full_auto_lease",
    }),
  } as const;
  const leaseCap = sessionSupportRow(caps, { type: "lease" });
  // These fields are visible, but the current projection does not expose
  // option-specific support. Missing evidence must not become authority.
  const sandboxCap = sessionSupportRow(caps, { type: "sandbox" });
  const networkCap = sessionSupportRow(caps, { type: "network" });
  const active = activeLease(lease);
  const remaining = leaseRemainingMs(lease, now);
  const mutable = (snapshot?.mutable ?? false) && controlCap.ok;

  if (!snapshot) {
    return (
      <section className="m9-panel controls-panel">
        <p className="empty-state">Select a Session to load settings.</p>
      </section>
    );
  }

  const update = (patch: Partial<SessionSettings>) => {
    onUpdateSettings({ ...snapshot.settings, ...patch });
  };

  const currentExecSupport =
    snapshot.settings.executionMode === "ask"
      ? execCapAsk
      : snapshot.settings.executionMode === "plan"
        ? execCapPlan
        : execCapAuto;
  const currentApprovalSupport =
    approvalRows[snapshot.settings.approvalPolicy] ?? controlCap;

  return (
    <section className="m9-panel controls-panel" aria-labelledby="controls-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SESSION CONTROLS</p>
          <h2 id="controls-title">
            Settings rev {snapshot.revision}
            {caps ? ` · cap rev ${caps.settingsRevision}` : ""}
          </h2>
        </div>
        <div className="panel-heading-actions">
          <FreshnessBadge status={settings.status} />
          <FreshnessBadge status={sessionCapabilities.status} />
        </div>
      </div>
      {settings.conflict && (
        <p className="inline-error" role="alert">
          Stale revision conflict — UI replaced with server settings rev{" "}
          {settings.conflict.revision}.
        </p>
      )}
      {settings.error && <p className="inline-error" role="alert">{settings.error}</p>}
      {!controlCap.ok && (
        <p className="control-reason" role="status">
          {controlCap.reason}
        </p>
      )}
      {caps && (
        <p className="mono-meta">
          bind {caps.controlAuthority.bindingStatus}
          {caps.provider.providerId ? ` · ${caps.provider.providerId}` : ""}
          {caps.account.accountId ? ` · ${caps.account.accountId}` : ""}
          {caps.model.modelId ? ` · model ${caps.model.modelId}` : ""}
          {` · ${caps.freshness}`}
        </p>
      )}
      {!mutable && (
        <p className="control-reason">
          Settings are immutable while a Turn is active, binding is not ready, or
          Session authority is withdrawn.
        </p>
      )}

      <div className="control-grid">
        <label>
          Provider
          <input value={snapshot.settings.providerId} disabled readOnly />
          <DisabledReason
            reason={
              !sessionSupportRow(caps, { type: "provider" }).ok
                ? sessionSupportRow(caps, { type: "provider" }).reason
                : null
            }
          />
        </label>
        <label>
          Account
          <input value={snapshot.settings.accountId ?? "—"} disabled readOnly />
          <DisabledReason
            reason={
              !sessionSupportRow(caps, { type: "account" }).ok
                ? sessionSupportRow(caps, { type: "account" }).reason
                : null
            }
          />
        </label>
        <label>
          Project
          <input
            value={snapshot.settings.projectPath ?? "—"}
            disabled
            readOnly
            title={snapshot.settings.projectPath ?? undefined}
          />
        </label>
        <label>
          Model
          <select
            value={snapshot.settings.model ?? ""}
            disabled={!mutable || !modelCap.ok || models.length === 0}
            onChange={(event) =>
              update({ model: event.target.value === "" ? null : event.target.value })
            }
          >
            <option value="">Unavailable / default</option>
            {models.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.displayName}
              </option>
            ))}
          </select>
          <DisabledReason
            reason={
              !modelCap.ok
                ? modelCap.reason
                : models.length === 0
                  ? "No models in live inventory"
                  : null
            }
          />
        </label>
        <label>
          Reasoning
          <select
            value={snapshot.settings.reasoningLevel ?? ""}
            disabled={!mutable || !reasonCap.ok}
            onChange={(event) =>
              update({
                reasoningLevel: event.target.value === "" ? null : event.target.value,
              })
            }
          >
            <option value="">None</option>
            {(
              models.find((model) => model.modelId === snapshot.settings.model)
                ?.reasoningEfforts ?? []
            ).map((option) => (
              <option key={option.value} value={option.value}>
                {option.value}
              </option>
            ))}
          </select>
          <DisabledReason reason={!reasonCap.ok ? reasonCap.reason : null} />
        </label>
        <label>
          Execution mode
          <select
            value={snapshot.settings.executionMode}
            disabled={!mutable || !currentExecSupport.ok}
            onChange={(event) =>
              update({
                executionMode: event.target.value as SessionSettings["executionMode"],
              })
            }
          >
            <option value="ask" disabled={!execCapAsk.ok}>
              ask{!execCapAsk.ok ? " (unsupported)" : ""}
            </option>
            <option value="plan" disabled={!execCapPlan.ok}>
              plan{!execCapPlan.ok ? " (unsupported)" : ""}
            </option>
            <option value="auto" disabled={!execCapAuto.ok}>
              auto{!execCapAuto.ok ? " (unsupported)" : ""}
            </option>
          </select>
          <DisabledReason reason={!currentExecSupport.ok ? currentExecSupport.reason : null} />
        </label>
        <label>
          Approval policy
          <select
            value={snapshot.settings.approvalPolicy}
            disabled={!mutable || !currentApprovalSupport.ok}
            onChange={(event) =>
              update({
                approvalPolicy: event.target
                  .value as SessionSettings["approvalPolicy"],
              })
            }
          >
            <option value="review" disabled={!approvalRows.review.ok}>
              review
            </option>
            <option value="balanced" disabled={!approvalRows.balanced.ok}>
              balanced
            </option>
            <option value="workspace_auto" disabled={!approvalRows.workspace_auto.ok}>
              workspace_auto
            </option>
            <option value="full_auto_lease" disabled={!approvalRows.full_auto_lease.ok}>
              full_auto_lease
            </option>
          </select>
          <DisabledReason
            reason={!currentApprovalSupport.ok ? currentApprovalSupport.reason : null}
          />
        </label>
        <label>
          Sandbox
          <select
            value={snapshot.settings.sandboxPolicy}
            disabled
            onChange={(event) =>
              update({
                sandboxPolicy: event.target.value as SessionSettings["sandboxPolicy"],
              })
            }
          >
            <option value="read_only">read_only</option>
            <option value="workspace_write">workspace_write</option>
          </select>
          <DisabledReason reason={!sandboxCap.ok ? sandboxCap.reason : null} />
        </label>
        <label>
          Network
          <select
            value={snapshot.settings.networkPolicy}
            disabled
            onChange={(event) =>
              update({
                networkPolicy: event.target.value as SessionSettings["networkPolicy"],
              })
            }
          >
            <option value="denied">denied</option>
            <option value="restricted">restricted</option>
          </select>
          <DisabledReason reason={!networkCap.ok ? networkCap.reason : null} />
        </label>
      </div>

      <div className="lease-block">
        <p className="eyebrow">FULL AUTO LEASE</p>
        {active ? (
          <p className="lease-status">
            Active · expires {new Date(active.expiresAt).toLocaleTimeString()} ·{" "}
            {remaining !== null ? `${Math.ceil(remaining / 1000)}s left` : "—"}
          </p>
        ) : (
          <p className="lease-status">No active lease</p>
        )}
        <div className="actions">
          {([15, 30, 60] as const).map((minutes) => (
            <button
              key={minutes}
              type="button"
              className="secondary-button"
              disabled={
                !leaseCap.ok ||
                !controlCap.ok ||
                snapshot.settings.approvalPolicy !== "full_auto_lease" ||
                runtimeId === null ||
                runtimeGeneration === null
              }
              title={
                !leaseCap.ok
                  ? leaseCap.reason ?? "Unavailable"
                  : !controlCap.ok
                    ? controlCap.reason ?? "Session not controllable"
                    : snapshot.settings.approvalPolicy !== "full_auto_lease"
                      ? "Set approval policy to full_auto_lease first"
                      : runtimeId === null
                        ? "Runtime unavailable"
                        : `Create ${minutes}m lease`
              }
              onClick={() => onCreateLease(minutes)}
            >
              Lease {minutes}m
            </button>
          ))}
          <button
            type="button"
            className="secondary-button"
            disabled={!active}
            onClick={onRevokeLease}
          >
            Revoke lease
          </button>
          <button type="button" className="danger-button" onClick={onEmergencyStop}>
            Emergency stop
          </button>
        </div>
        <DisabledReason reason={!leaseCap.ok ? leaseCap.reason : null} />
      </div>
    </section>
  );
}

export function AttachmentComposer({
  attachments,
  selectedAttachmentIds,
  uploadProgress,
  error,
  canAttachText,
  canAttachImage,
  disabledReason,
  onPickFiles,
  onToggleSelection,
  onDelete,
}: {
  attachments: InputAttachment[];
  selectedAttachmentIds: string[];
  uploadProgress: AttachmentUiState["uploadProgress"];
  error: string | null;
  canAttachText: boolean;
  canAttachImage: boolean;
  disabledReason: string | null;
  onPickFiles: (files: FileList) => void;
  onToggleSelection: (attachmentId: string) => void;
  onDelete: (attachmentId: string) => void;
}) {
  const accept = [
    canAttachText ? ".txt,.md,text/plain,text/markdown" : "",
    canAttachImage ? "image/png,image/jpeg,image/gif,image/webp" : "",
  ]
    .filter(Boolean)
    .join(",");

  return (
    <div className="attachment-composer">
      <div className="composer-heading">
        <span className="field-label">Managed attachments</span>
        <span className="mono-meta">
          {selectedAttachmentIds.filter((id) =>
            attachments.some(
              (attachment) =>
                attachment.attachmentId === id && attachment.status === "ready",
            ),
          ).length}
          /8 selected · {attachments.filter((a) => a.status === "ready").length} ready
        </span>
      </div>
      <label className="attachment-pick">
        <span>Add file</span>
        <input
          type="file"
          multiple
          accept={accept || undefined}
          disabled={disabledReason !== null || (!canAttachText && !canAttachImage)}
          onChange={(event) => {
            if (event.target.files) onPickFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <DisabledReason reason={disabledReason} />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <ul className="attachment-list">
        {attachments
          .filter((item) => item.status !== "deleted")
          .map((item) => {
            const progress = uploadProgress[item.attachmentId];
            return (
              <li key={item.attachmentId}>
                {item.status === "ready" ? (
                  <input
                    className="attachment-select"
                    type="checkbox"
                    aria-label={`Include ${item.name} in the next Turn`}
                    checked={selectedAttachmentIds.includes(item.attachmentId)}
                    onChange={() => onToggleSelection(item.attachmentId)}
                  />
                ) : (
                  <span className="attachment-select-placeholder" aria-hidden="true" />
                )}
                <span className="attachment-name" title={item.name}>{item.name}</span>
                <span className="mono-meta">{item.status}</span>
                {progress && (
                  <span className="mono-meta">
                    {progress.received}/{progress.total} chunks
                  </span>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={item.status === "referenced"}
                  onClick={() => onDelete(item.attachmentId)}
                >
                  Remove
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}

export function TerminalActivityDetails({
  activity,
}: {
  activity: {
    title: string;
    command?: string | null;
    cwdLabel?: string | null;
    stdoutPreview?: string;
    stderrPreview?: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    stderrAvailable?: boolean;
    outputPreview: string;
    exitCode: number | null;
    durationMs: number | null;
  };
}) {
  const stdout = activity.stdoutPreview ?? activity.outputPreview;
  const stderr = activity.stderrPreview;
  return (
    <div className="terminal-activity">
      {activity.command && (
        <p className="mono-meta">cmd: {activity.command}</p>
      )}
      {activity.cwdLabel && (
        <p className="mono-meta">cwd: {activity.cwdLabel}</p>
      )}
      <pre className="stdout-preview">{stdout || "No stdout evidence"}</pre>
      {activity.stdoutTruncated && (
        <p className="control-reason">Stdout preview truncated</p>
      )}
      {activity.stderrAvailable === false ? (
        <p className="control-reason">
          Separate stderr unavailable — provider exposes aggregated output only
        </p>
      ) : (
        stderr !== undefined && (
          <>
            <pre className="stderr-preview">{stderr || "No stderr"}</pre>
            {activity.stderrTruncated && (
              <p className="control-reason">Stderr preview truncated</p>
            )}
          </>
        )
      )}
      <p className="mono-meta">
        exit {activity.exitCode ?? "—"} · {activity.durationMs ?? "—"} ms
      </p>
    </div>
  );
}

export function CreateSessionForm({
  fleet,
  selectedProviderId,
  selectedAccountId,
  onSubmit,
  disabledReason,
}: {
  fleet: ProviderFleetSnapshot | null;
  selectedProviderId: string | null;
  selectedAccountId: string | null;
  onSubmit: (input: {
    title: string;
    sessionId: string;
    projectPath: string;
    model: string | null;
    reasoningLevel: string | null;
  }) => void;
  disabledReason: string | null;
}) {
  const providers = controllableProviders(fleet);
  const provider =
    providers.find((item) => item.providerId === selectedProviderId) ??
    providers[0] ??
    null;
  const models = provider?.models.filter((model) => !model.hidden) ?? [];
  const [selectedModelId, setSelectedModelId] = useState("");
  const modelIds = models.map((model) => model.modelId).join("\u0000");
  const effectiveModel =
    models.find((model) => model.modelId === selectedModelId) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null;
  const [selectedReasoning, setSelectedReasoning] = useState("");

  useEffect(() => {
    if (
      selectedModelId !== "" &&
      !models.some((model) => model.modelId === selectedModelId)
    ) {
      setSelectedModelId("");
    }
    setSelectedReasoning("");
  }, [provider?.providerId, selectedModelId, modelIds]);

  const handle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      title: String(data.get("title") ?? "").trim(),
      sessionId: String(data.get("sessionId") ?? "").trim(),
      projectPath: String(data.get("projectPath") ?? "").trim(),
      model: String(data.get("model") ?? "") || null,
      reasoningLevel: String(data.get("reasoning") ?? "") || null,
    });
  };

  return (
    <form className="create-session-form" onSubmit={handle}>
      <p className="eyebrow">NEW AICL SESSION</p>
      <label>
        Title
        <input name="title" required maxLength={160} placeholder="Mission title" />
      </label>
      <label>
        Session ID
        <input
          name="sessionId"
          required
          pattern="[A-Za-z0-9._\-]{1,100}"
          placeholder="session-ops-1"
        />
      </label>
      <label>
        Project path
        <input name="projectPath" required maxLength={4096} placeholder="C:\Projects\demo" />
      </label>
      <label>
        Model
        <select
          name="model"
          value={selectedModelId}
          onChange={(event) => setSelectedModelId(event.target.value)}
        >
          <option value="">Provider default</option>
          {models.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reasoning
        <select
          name="reasoning"
          value={selectedReasoning}
          onChange={(event) => setSelectedReasoning(event.target.value)}
        >
          <option value="">None</option>
          {(effectiveModel?.reasoningEfforts ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.value}
            </option>
          ))}
        </select>
      </label>
      <p className="mono-meta">
        Provider {provider?.providerId ?? "—"} · Account {selectedAccountId ?? "—"}
      </p>
      <DisabledReason reason={disabledReason} />
      <button type="submit" disabled={disabledReason !== null || !provider || !selectedAccountId}>
        Create
      </button>
    </form>
  );
}
