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

/** Compact flight header: menu · identity · single link-state control. */
export function MobileHeader(props: MobileHeaderProps) {
  const route = `${props.providerLabel} / ${props.accountLabel}`;
  const session = props.sessionTitle ?? "Account home";
  const linkLabel = compactLinkLabel(props.statusTone, props.statusLabel, props.activityLabel);
  return (
    <header className="mobile-header">
      <button
        type="button"
        className="mobile-icon-button"
        aria-label="Open accounts and Sessions"
        data-testid="mobile-drawer-trigger"
        title="Accounts and Sessions"
        onClick={props.onOpenDrawer}
      >
        <MenuIcon />
      </button>
      <button
        type="button"
        className="mobile-header-identity"
        aria-label={`Open accounts. ${route}. ${session}`}
        title={`${route}\n${session}`}
        onClick={props.onOpenDrawer}
      >
        <strong>{route}</strong>
        <span>{session}</span>
      </button>
      <button
        type="button"
        className="mobile-status-button"
        data-tone={props.statusTone}
        data-testid="mobile-status-trigger"
        aria-label={`System status: ${props.statusLabel}, ${props.activityLabel}`}
        title={`${props.statusLabel} · ${props.activityLabel}`}
        onClick={props.onOpenStatus}
      >
        <span className="mobile-status-dot" aria-hidden="true" />
        <span className="mobile-status-word">{linkLabel}</span>
      </button>
    </header>
  );
}

function compactLinkLabel(
  tone: MobileHeaderProps["statusTone"],
  statusLabel: string,
  activityLabel: string,
): string {
  if (tone === "offline") return "OFFLINE";
  if (tone === "working") return "LIVE";
  if (tone === "warning") return "HOLD";
  if (/ready|connected/i.test(statusLabel) && /ready|idle/i.test(activityLabel)) return "LINK";
  return statusLabel.split(/\s+/)[0]?.toUpperCase() ?? "STATUS";
}
