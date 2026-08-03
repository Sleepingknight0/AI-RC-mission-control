import type {
  ApprovalLeaseSnapshot,
  InputAttachment,
  ProviderFleetSnapshot,
  ProviderNativeSessionSnapshot,
  ProviderRecord,
  SessionCatalogFilter,
  SessionSettings,
  SessionSettingsSnapshot,
  SessionSummaryV2,
} from "@aicl/protocol";
import type { FormEvent, ReactNode } from "react";

import {
  activeLease,
  capabilitySupported,
  controllableProviders,
  leaseRemainingMs,
  type AttachmentUiState,
  type CatalogState,
  type FleetState,
  type NativeState,
  type ResourceFreshness,
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
  onSearch,
  onLoadMore,
  onCreate,
  onResumeNative,
  onPin,
  onArchive,
  onRefreshNative,
  createDisabledReason,
}: {
  catalog: CatalogState;
  native: NativeState;
  selectedSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onSearch: (search: string) => void;
  onLoadMore: () => void;
  onCreate: () => void;
  onResumeNative: (providerSessionId: string) => void;
  onPin: (session: SessionSummaryV2) => void;
  onArchive: (session: SessionSummaryV2) => void;
  onRefreshNative: () => void;
  createDisabledReason: string | null;
}) {
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
          defaultValue={catalog.filters.search ?? ""}
          placeholder="Title, provider, project…"
          onChange={(event) => onSearch(event.target.value)}
        />
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
                  disabled={!session.canControl}
                  onClick={() => onPin(session)}
                >
                  {session.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={!session.canControl || session.state === "running"}
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
        <button type="button" className="secondary-button" onClick={onLoadMore}>
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
        {native.snapshot?.notice && <p className="panel-notice">{native.snapshot.notice}</p>}
        {(native.snapshot?.sessions ?? []).length === 0 ? (
          <p className="empty-state">No native Sessions in current snapshot.</p>
        ) : (
          <ul className="native-list">
            {native.snapshot!.sessions.map((session) => (
              <li key={session.providerSessionId}>
                <span title={session.title}>{session.title}</span>
                <span className="mono-meta">{session.providerStatus}</span>
                <button
                  type="button"
                  className="text-button"
                  disabled={!session.canResume}
                  title={session.canResume ? "Resume" : "Resume not available"}
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
  const provider =
    fleet?.providers.find((item) => item.providerId === snapshot?.settings.providerId) ??
    null;
  const models = provider?.models.filter((model) => !model.hidden) ?? [];
  const modelCap = capabilitySupported(provider, "change_model");
  const reasonCap = capabilitySupported(provider, "reasoning_levels");
  const execCap = capabilitySupported(provider, "execution_modes");
  const approvalCap = capabilitySupported(provider, "approval_policies");
  const sandboxCap = capabilitySupported(provider, "sandbox_policies");
  const networkCap = capabilitySupported(provider, "network_policies");
  const leaseCap = approvalCap;
  const active = activeLease(lease);
  const remaining = leaseRemainingMs(lease, now);
  const mutable = snapshot?.mutable ?? false;

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

  return (
    <section className="m9-panel controls-panel" aria-labelledby="controls-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SESSION CONTROLS</p>
          <h2 id="controls-title">Settings rev {snapshot.revision}</h2>
        </div>
        <FreshnessBadge status={settings.status} />
      </div>
      {settings.conflict && (
        <p className="inline-error" role="alert">
          Stale revision conflict — UI replaced with server settings rev{" "}
          {settings.conflict.revision}.
        </p>
      )}
      {settings.error && <p className="inline-error" role="alert">{settings.error}</p>}
      {!mutable && (
        <p className="control-reason">Settings are immutable while a Turn is active or binding is not ready.</p>
      )}

      <div className="control-grid">
        <label>
          Provider
          <input value={snapshot.settings.providerId} disabled readOnly />
        </label>
        <label>
          Account
          <input value={snapshot.settings.accountId ?? "—"} disabled readOnly />
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
          <DisabledReason reason={!modelCap.ok ? modelCap.reason : models.length === 0 ? "No models in live inventory" : null} />
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
            disabled={!mutable || !execCap.ok}
            onChange={(event) =>
              update({
                executionMode: event.target.value as SessionSettings["executionMode"],
              })
            }
          >
            <option value="ask">ask</option>
            <option value="plan">plan</option>
            <option value="auto">auto</option>
          </select>
          <DisabledReason reason={!execCap.ok ? execCap.reason : null} />
        </label>
        <label>
          Approval policy
          <select
            value={snapshot.settings.approvalPolicy}
            disabled={!mutable || !approvalCap.ok}
            onChange={(event) =>
              update({
                approvalPolicy: event.target
                  .value as SessionSettings["approvalPolicy"],
              })
            }
          >
            <option value="review">review</option>
            <option value="balanced">balanced</option>
            <option value="workspace_auto">workspace_auto</option>
            <option value="full_auto_lease">full_auto_lease</option>
          </select>
          <DisabledReason reason={!approvalCap.ok ? approvalCap.reason : null} />
        </label>
        <label>
          Sandbox
          <select
            value={snapshot.settings.sandboxPolicy}
            disabled={!mutable || !sandboxCap.ok}
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
            disabled={!mutable || !networkCap.ok}
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
                snapshot.settings.approvalPolicy !== "full_auto_lease" ||
                runtimeId === null ||
                runtimeGeneration === null
              }
              title={
                !leaseCap.ok
                  ? leaseCap.reason ?? "Unavailable"
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
  uploadProgress,
  error,
  canAttachText,
  canAttachImage,
  disabledReason,
  onPickFiles,
  onDelete,
}: {
  attachments: InputAttachment[];
  uploadProgress: AttachmentUiState["uploadProgress"];
  error: string | null;
  canAttachText: boolean;
  canAttachImage: boolean;
  disabledReason: string | null;
  onPickFiles: (files: FileList) => void;
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
        <span className="mono-meta">{attachments.filter((a) => a.status === "ready").length}/8 ready</span>
      </div>
      <label className="attachment-pick">
        <span>Add file</span>
        <input
          type="file"
          multiple
          accept={accept || undefined}
          disabled={!canAttachText && !canAttachImage}
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
                <span title={item.name}>{item.name}</span>
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
          pattern="[A-Za-z0-9._-]{1,100}"
          placeholder="session-ops-1"
        />
      </label>
      <label>
        Project path
        <input name="projectPath" required maxLength={4096} placeholder="C:\Projects\demo" />
      </label>
      <label>
        Model
        <select name="model" defaultValue="">
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
        <select name="reasoning" defaultValue="">
          <option value="">None</option>
          {(models[0]?.reasoningEfforts ?? []).map((option) => (
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

export function ResourceShell({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <div className="resource-shell" data-title={title}>
      {children}
    </div>
  );
}
