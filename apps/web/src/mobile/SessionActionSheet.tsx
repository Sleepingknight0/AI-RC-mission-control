import type { MobileSessionRow } from "./state.js";
import { MobileOverlay, MobileOverlayHeading } from "./MobileOverlay.js";
import type { ReactNode } from "react";
import { useEffect, useState, type FormEvent } from "react";

export function SessionActionSheet({
  open,
  session,
  onClose,
  onRename,
  onPin,
  onArchive,
  onResumeRuntime,
  children,
}: {
  open: boolean;
  session: MobileSessionRow | null;
  onClose: () => void;
  onRename: (session: MobileSessionRow, title: string) => void;
  onPin: (session: MobileSessionRow) => void;
  onArchive: (session: MobileSessionRow) => void;
  onResumeRuntime?: (session: MobileSessionRow) => void;
  children?: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session?.title ?? "");
  useEffect(() => {
    setTitle(session?.title ?? "");
    setRenaming(false);
  }, [session]);
  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (session === null || title.trim() === "") return;
    onRename(session, title.trim());
    setRenaming(false);
  };
  return (
    <MobileOverlay open={open} variant="sheet" title="Session actions" testId="mobile-session-actions" onClose={onClose}>
      <MobileOverlayHeading title={session?.title ?? "Session actions"} detail={session?.projectName ?? "Project unavailable"} onClose={onClose} />
      {children}
      {session?.catalog !== null && session !== null && (
        <div className="mobile-action-list">
          {onResumeRuntime !== undefined && session.canResume && (
            <button type="button" data-testid="mobile-resume-runtime" onClick={() => onResumeRuntime(session)}>Resume provider Runtime</button>
          )}
          <button type="button" onClick={() => setRenaming((open) => !open)}>Rename</button>
          {renaming && (
            <form className="mobile-rename-form" onSubmit={submitRename}>
              <label><span className="sr-only">New Session title</span><input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></label>
              <button type="submit" disabled={title.trim() === "" || title.trim() === session.title}>Save name</button>
            </form>
          )}
          <button type="button" onClick={() => onPin(session)}>{session.pinned ? "Unpin" : "Pin"}</button>
          <button type="button" onClick={() => onArchive(session)}>{session.archived ? "Unarchive" : "Archive"}</button>
        </div>
      )}
    </MobileOverlay>
  );
}
