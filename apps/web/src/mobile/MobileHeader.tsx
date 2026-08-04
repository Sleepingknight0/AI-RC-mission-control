import { MenuIcon } from "./icons.js";

export interface MobileHeaderProps {
  providerLabel: string;
  accountLabel: string;
  sessionTitle: string | null;
  statusLabel: string;
  statusTone: "ready" | "working" | "warning" | "offline";
  activityLabel: string;
  onOpenDrawer: () => void;
  onOpenStatus: () => void;
}

export function MobileHeader(props: MobileHeaderProps) {
  const identity = `${props.providerLabel} · ${props.accountLabel}`;
  return (
    <header className="mobile-header">
      <div className="mobile-header-rail" aria-hidden="true" />
      <button
        type="button"
        className="mobile-icon-button"
        aria-label="Open accounts and Sessions"
        data-testid="mobile-drawer-trigger"
        onClick={props.onOpenDrawer}
      >
        <MenuIcon />
      </button>
      <div className="mobile-header-copy">
        <strong title={identity}>{identity}</strong>
        <span title={props.sessionTitle ?? "Account home"}>
          {props.sessionTitle ?? "Account home"}
        </span>
      </div>
      <button
        type="button"
        className="mobile-status-button"
        data-tone={props.statusTone}
        data-testid="mobile-status-trigger"
        aria-label={`System status: ${props.statusLabel}, ${props.activityLabel}`}
        onClick={props.onOpenStatus}
      >
        <span className="mobile-status-dot" aria-hidden="true" />
        <span>
          <strong>{props.statusLabel}</strong>
          <small>{props.activityLabel}</small>
        </span>
      </button>
    </header>
  );
}
