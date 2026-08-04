import { MobileOverlay, MobileOverlayHeading } from "./MobileOverlay.js";

export interface StatusFact {
  label: string;
  value: string;
  tone?: "ready" | "warning" | "offline";
}

export function SystemStatusSheet({
  open,
  facts,
  onClose,
}: {
  open: boolean;
  facts: readonly StatusFact[];
  onClose: () => void;
}) {
  return (
    <MobileOverlay open={open} variant="sheet" title="System status" testId="mobile-system-status-sheet" onClose={onClose}>
      <MobileOverlayHeading title="System status" detail="Current authority and connection evidence" onClose={onClose} />
      <dl className="mobile-status-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd data-tone={fact.tone}>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </MobileOverlay>
  );
}
