import type { ReactNode } from "react";

import { MobileOverlay, MobileOverlayHeading } from "./MobileOverlay.js";

export function MobileEvidenceSheet({
  open,
  title,
  detail,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  detail: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <MobileOverlay open={open} variant="sheet" title="Session evidence" testId="mobile-session-evidence" onClose={onClose}>
      <MobileOverlayHeading title={title} detail={detail} onClose={onClose} />
      <div className="mobile-evidence-scroll">{children}</div>
    </MobileOverlay>
  );
}
