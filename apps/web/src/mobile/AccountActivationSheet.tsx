import { MobileOverlay, MobileOverlayHeading } from "./MobileOverlay.js";

export function AccountActivationSheet({
  open,
  providerLabel,
  accountLabel,
  actionLabel,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  providerLabel: string;
  accountLabel: string;
  actionLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <MobileOverlay open={open} variant="sheet" title="Switch active account" testId="mobile-account-activation" onClose={onClose}>
      <MobileOverlayHeading title="Switch active account?" detail={`${providerLabel} · ${accountLabel}`} onClose={onClose} />
      <div className="mobile-confirm-copy">
        <p>{actionLabel} needs a live provider Runtime for this exact account.</p>
        <p>The current Runtime will be replaced. No prompt or prior command will be replayed.</p>
      </div>
      <div className="mobile-confirm-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" disabled={busy} onClick={onConfirm}>{busy ? "Switching…" : "Switch and continue"}</button>
      </div>
    </MobileOverlay>
  );
}
