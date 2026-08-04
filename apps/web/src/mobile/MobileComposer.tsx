import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { PlusIcon, SendIcon, StopIcon } from "./icons.js";

export function MobileComposer({
  value,
  modelLabel,
  modeLabel,
  busy,
  canSubmit,
  disabledReason,
  canAttachText,
  canAttachImage,
  attachmentDisabledReason,
  attachmentChips,
  onChange,
  onSubmit,
  onAbort,
  onOpenModelMode,
  onPickFiles,
}: {
  value: string;
  modelLabel: string;
  modeLabel: string;
  busy: boolean;
  canSubmit: boolean;
  disabledReason: string;
  canAttachText: boolean;
  canAttachImage: boolean;
  attachmentDisabledReason: string | null;
  attachmentChips: ReactNode;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onAbort: () => void;
  onOpenModelMode: () => void;
  onPickFiles: (files: FileList) => void;
}) {
  const [plusOpen, setPlusOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const accept = [canAttachText ? ".txt,.md,.json,.csv,.log,text/plain,text/markdown,application/json,text/csv" : "", canAttachImage ? "image/png,image/jpeg,image/webp,image/gif" : ""]
    .filter(Boolean)
    .join(",");
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  const modelMode = `${modelLabel} · ${modeLabel}`;
  const attachmentAvailable = attachmentDisabledReason === null && (canAttachText || canAttachImage);
  const openFilePicker = () => {
    setPlusOpen(false);
    inputRef.current?.click();
  };
  return (
    <form className="mobile-composer" data-testid="mobile-composer" onSubmit={onSubmit}>
      {attachmentChips}
      {plusOpen && (
        <div className="mobile-plus-menu" role="menu" aria-label="Add to prompt">
          {attachmentAvailable ? (
            <button type="button" role="menuitem" onClick={openFilePicker}>
              {canAttachImage && canAttachText ? "Choose image or file" : canAttachImage ? "Choose image" : "Choose file"}
            </button>
          ) : <p>No attachment actions are supported.</p>}
        </div>
      )}
      <div className="mobile-composer-input-row">
        <button
          type="button"
          className="mobile-icon-button mobile-plus-button"
          data-testid="mobile-attachment-trigger"
          aria-label={attachmentDisabledReason === null ? "Add attachment" : `Attachments unavailable: ${attachmentDisabledReason}`}
          title={attachmentDisabledReason ?? "Add attachment"}
          aria-expanded={plusOpen}
          disabled={!attachmentAvailable}
          onClick={() => setPlusOpen((open) => !open)}
        >
          <PlusIcon />
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept={accept}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            if (event.target.files !== null) onPickFiles(event.target.files);
            event.currentTarget.value = "";
            setPlusOpen(false);
          }}
        />
        <label className="mobile-prompt-field">
          <span className="sr-only">Prompt</span>
          <textarea
            value={value}
            rows={1}
            placeholder="Message…"
            aria-describedby="mobile-composer-help"
            onChange={(event) => {
              onChange(event.target.value);
              const target = event.currentTarget;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
            }}
            onKeyDown={handleKeyDown}
          />
        </label>
        <button
          type={busy ? "button" : "submit"}
          className="mobile-send-button"
          data-testid={busy ? "mobile-abort" : "mobile-send"}
          disabled={busy ? false : !canSubmit || value.trim() === ""}
          aria-label={busy ? "Abort active Turn" : "Send prompt"}
          title={busy ? "Abort" : "Send"}
          onClick={busy ? onAbort : undefined}
        >
          {busy ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
      <div className="mobile-composer-settings">
        <button
          type="button"
          data-testid="mobile-model-mode-trigger"
          title="Model and mode"
          aria-label={`Model and mode: ${modelMode}`}
          onClick={onOpenModelMode}
        >
          <span>{modelMode}</span>
        </button>
        <small id="mobile-composer-help" title={`${disabledReason} Drafts never auto-send.`}>
          {shortReason(disabledReason)}
        </small>
      </div>
    </form>
  );
}

function shortReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length <= 42) return trimmed;
  return `${trimmed.slice(0, 39)}…`;
}
