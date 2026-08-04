import type { ProviderModel } from "@aicl/protocol";
import { useMemo, useState, type FormEvent } from "react";

export interface MobileCreateSessionInput {
  sessionId: string;
  title: string;
  projectPath: string;
  model: string | null;
  reasoningLevel: string | null;
}

export function MobileCreateSessionForm({
  models,
  disabledReason,
  onSubmit,
}: {
  models: readonly ProviderModel[];
  disabledReason: string | null;
  onSubmit: (input: MobileCreateSessionInput) => void;
}) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0] ?? null;
  const [sessionId, setSessionId] = useState("");
  const [title, setTitle] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [modelId, setModelId] = useState(defaultModel?.modelId ?? "");
  const selectedModel = useMemo(
    () => models.find((model) => model.modelId === modelId) ?? defaultModel,
    [defaultModel, modelId, models],
  );
  const [reasoning, setReasoning] = useState(defaultModel?.defaultReasoningEffort ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabledReason !== null) return;
    onSubmit({
      sessionId: sessionId.trim(),
      title: title.trim(),
      projectPath: projectPath.trim(),
      model: selectedModel?.modelId ?? null,
      reasoningLevel: reasoning || (selectedModel?.defaultReasoningEffort ?? null),
    });
  };
  return (
    <form className="mobile-session-create" onSubmit={submit}>
      <label>Session ID<input required pattern="[A-Za-z0-9._\-]{1,100}" placeholder="mission-control" value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
      <label>Title<input required maxLength={160} placeholder="Mission Control" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Project path<input required placeholder="C:\\workspace" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} /></label>
      <label>Model<select value={selectedModel?.modelId ?? ""} disabled={models.length === 0} onChange={(event) => {
        const next = models.find((model) => model.modelId === event.target.value) ?? null;
        setModelId(event.target.value);
        setReasoning(next?.defaultReasoningEffort ?? "");
      }}>{models.map((model) => <option key={model.modelId} value={model.modelId}>{model.displayName}</option>)}</select></label>
      <label>Reasoning<select value={reasoning} disabled={(selectedModel?.reasoningEfforts.length ?? 0) === 0} onChange={(event) => setReasoning(event.target.value)}>
        {(selectedModel?.reasoningEfforts ?? []).map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
      </select></label>
      {disabledReason !== null && <p className="mobile-list-notice" role="status">{disabledReason}</p>}
      <button type="submit" disabled={disabledReason !== null || models.length === 0}>Create Session</button>
    </form>
  );
}
