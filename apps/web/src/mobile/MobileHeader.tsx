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
  return (
    <header className="mobile-header">
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
        <strong title={`${props.providerLabel} · ${props.accountLabel}`}>
          {props.providerLabel} <span aria-hidden="true">·</span> {props.accountLabel}
        </strong>
        <span title={props.sessionTitle ?? "Account home"}>{props.sessionTitle ?? "Account home"}</span>
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
