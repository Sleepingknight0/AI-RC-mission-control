import type {
  ProviderModel,
  SessionCapabilitiesSnapshot,
  SessionSettings,
  SessionSettingsSnapshot,
} from "@aicl/protocol";

import { MobileOverlay, MobileOverlayHeading } from "./MobileOverlay.js";

type SupportRow = { state: string; reason: string | null } | undefined;

function Choice({
  label,
  description,
  selected,
  disabledReason,
  suppressDisabledDetail = false,
  onSelect,
}: {
  label: string;
  description?: string;
  selected: boolean;
  disabledReason: string | null;
  /** When true, a section banner already explains the shared disabled reason. */
  suppressDisabledDetail?: boolean;
  onSelect: () => void;
}) {
  const descriptionText = description !== undefined && description.trim() !== ""
    ? description
    : null;
  const detail = descriptionText
    ?? (!suppressDisabledDetail && disabledReason !== null ? disabledReason : null);
  const title = suppressDisabledDetail
    ? descriptionText ?? undefined
    : disabledReason ?? descriptionText ?? undefined;
  return (
    <button
      type="button"
      className="mobile-choice"
      aria-pressed={selected}
      disabled={disabledReason !== null}
      title={title}
      onClick={onSelect}
    >
      <span className="mobile-choice-mark" aria-hidden="true">{selected ? "✓" : ""}</span>
      <span>
        <strong>{label}</strong>
        {detail !== null && <small>{detail}</small>}
      </span>
    </button>
  );
}

function unsupportedReason(row: SupportRow, fallback: string) {
  return row?.state === "supported" ? null : row?.reason ?? fallback;
}

function formatReasoningLabel(value: string) {
  if (value.length === 0) return value;
  return value[0]!.toUpperCase() + value.slice(1);
}

export function ModelModeSheet({
  open,
  models,
  settings,
  capabilities,
  evidenceNotice,
  settingsNotice,
  onClose,
  onUpdate,
}: {
  open: boolean;
  models: readonly ProviderModel[];
  settings: SessionSettingsSnapshot | null;
  capabilities: SessionCapabilitiesSnapshot | null;
  evidenceNotice: string | null;
  settingsNotice: string | null;
  onClose: () => void;
  onUpdate: (settings: SessionSettings) => void;
}) {
  const current = settings?.settings ?? null;
  const selectedModel = models.find((model) => model.modelId === current?.model) ?? null;
  const reasoning = selectedModel?.reasoningEfforts ?? [];
  const mutable = settings?.mutable === true;
  const update = (patch: Partial<SessionSettings>) => {
    if (current === null || !mutable) return;
    onUpdate({ ...current, ...patch });
  };
  const modelAuthority = capabilities?.model;
  const modelUnavailable = !mutable
    ? "Settings are not mutable"
    : capabilities === null
      ? "Session capability projection unavailable"
      : modelAuthority?.state !== "supported"
        ? modelAuthority?.reason ?? "Model changes unsupported"
        : null;

  return (
    <MobileOverlay open={open} variant="sheet" title="Model and mode" testId="mobile-model-mode-sheet" onClose={onClose}>
      <MobileOverlayHeading title="Model and mode" detail={`Settings revision ${settings?.revision ?? "unavailable"}`} onClose={onClose} />
      <div className="mobile-sheet-scroll">
        {settingsNotice !== null && (
          <p className="mobile-list-notice warning" role="alert">{settingsNotice}</p>
        )}
        <section className="mobile-choice-section">
          <h3>Model</h3>
          {modelUnavailable !== null && (
            <p className="mobile-list-notice" role="status">{modelUnavailable}</p>
          )}
          {models.length === 0 ? (
            <p className="mobile-list-notice">{evidenceNotice ?? "No fresh models were reported for this account."}</p>
          ) : models.map((model) => (
            <Choice
              key={model.modelId}
              label={model.displayName}
              description={model.description}
              selected={model.modelId === current?.model}
              disabledReason={modelUnavailable}
              suppressDisabledDetail={modelUnavailable !== null}
              onSelect={() => update({
                model: model.modelId,
                reasoningLevel: model.defaultReasoningEffort,
              })}
            />
          ))}
        </section>
        <section className="mobile-choice-section">
          <h3>Reasoning</h3>
          {reasoning.length === 0 ? (
            <p className="mobile-list-notice">Select a model with advertised reasoning options.</p>
          ) : reasoning.map((option) => (
            <Choice
              key={option.value}
              label={formatReasoningLabel(option.value)}
              description={option.description}
              selected={option.value === current?.reasoningLevel}
              disabledReason={modelUnavailable}
              suppressDisabledDetail={modelUnavailable !== null}
              onSelect={() => update({ reasoningLevel: option.value })}
            />
          ))}
        </section>
        <section className="mobile-choice-section">
          <h3>Execution mode</h3>
          {!mutable && (
            <p className="mobile-list-notice" role="status">Settings are not mutable</p>
          )}
          {(["ask", "plan", "auto"] as const).map((mode) => {
            const row = capabilities?.executionModes.find((item) => item.mode === mode);
            return (
              <Choice
                key={mode}
                label={mode[0]?.toUpperCase() + mode.slice(1)}
                selected={mode === current?.executionMode}
                disabledReason={!mutable ? "Settings are not mutable" : unsupportedReason(row, `${mode} is unsupported`)}
                suppressDisabledDetail={!mutable}
                onSelect={() => update({ executionMode: mode })}
              />
            );
          })}
        </section>
        <section className="mobile-choice-section">
          <h3>Approval policy</h3>
          {!mutable && (
            <p className="mobile-list-notice" role="status">Settings are not mutable</p>
          )}
          {([
            ["review", "Review"],
            ["balanced", "Balanced"],
            ["workspace_auto", "Workspace Auto"],
            ["full_auto_lease", "Full Auto Lease"],
          ] as const).map(([policy, label]) => {
            const row = capabilities?.approvalPolicies.find((item) => item.policy === policy);
            return (
              <Choice
                key={policy}
                label={label}
                selected={policy === current?.approvalPolicy}
                disabledReason={!mutable ? "Settings are not mutable" : unsupportedReason(row, `${label} is unsupported`)}
                suppressDisabledDetail={!mutable}
                onSelect={() => update({ approvalPolicy: policy })}
              />
            );
          })}
        </section>
        {settings === null && <p className="mobile-list-notice" role="status">Waiting for current settings revision.</p>}
      </div>
    </MobileOverlay>
  );
}
