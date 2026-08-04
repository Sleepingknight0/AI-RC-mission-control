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
  return (
    <form className="mobile-composer" data-testid="mobile-composer" onSubmit={onSubmit}>
      {attachmentChips}
      {plusOpen && (
        <div className="mobile-plus-menu" role="menu" aria-label="Add to prompt">
          {(canAttachText || canAttachImage) ? (
            <button type="button" role="menuitem" onClick={() => inputRef.current?.click()}>
              {canAttachImage && canAttachText ? "Choose image or file" : canAttachImage ? "Choose image" : "Choose file"}
            </button>
          ) : <p>No attachment actions are supported.</p>}
        </div>
      )}
      <div className="mobile-composer-input-row">
        <button
          type="button"
          className="mobile-icon-button mobile-plus-button"
          aria-label="Add attachment"
          aria-expanded={plusOpen}
          disabled={!canAttachText && !canAttachImage}
          onClick={() => setPlusOpen((open) => !open)}
        >
          <PlusIcon />
        </button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          multiple
          accept={accept}
          tabIndex={-1}
          onChange={(event) => {
            if (event.target.files !== null) onPickFiles(event.target.files);
            event.currentTarget.value = "";
            setPlusOpen(false);
          }}
        />
        <label className="mobile-prompt-field">
          <span className="sr-only">Ask anything</span>
          <textarea
            value={value}
            rows={1}
            placeholder="Ask anything…"
            aria-describedby="mobile-composer-help"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </label>
        <button
          type={busy ? "button" : "submit"}
          className="mobile-send-button"
          data-testid={busy ? "mobile-abort" : "mobile-send"}
          disabled={busy ? false : !canSubmit || value.trim() === ""}
          aria-label={busy ? "Abort active Turn" : "Send prompt"}
          onClick={busy ? onAbort : undefined}
        >
          {busy ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
      <div className="mobile-composer-settings">
        <button type="button" data-testid="mobile-model-mode-trigger" onClick={onOpenModelMode}>
          <span title={modelLabel}>{modelLabel}</span>
          <span aria-hidden="true">·</span>
          <span>{modeLabel}</span>
        </button>
        <small id="mobile-composer-help">{disabledReason} Drafts never auto-send.</small>
      </div>
    </form>
  );
}
