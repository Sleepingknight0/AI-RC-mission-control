import { PlusIcon, SearchIcon } from "./icons.js";
import {
  mobileSessionStateLabel,
  recentSessionsByPeriod,
  type AccountStatus,
  type MobileSessionRow,
} from "./state.js";

export function MobileAccountHome({
  providerLabel,
  accountLabel,
  status,
  sessions,
  now,
  canCreate,
  createDisabledReason,
  onOpenSession,
  onResumeNative,
  onOpenDrawer,
  onCreate,
}: {
  providerLabel: string;
  accountLabel: string;
  status: AccountStatus;
  sessions: readonly MobileSessionRow[];
  now: number;
  canCreate: boolean;
  createDisabledReason: string | null;
  onOpenSession: (sessionId: string) => void;
  onResumeNative: (providerSessionId: string) => void;
  onOpenDrawer: () => void;
  onCreate: () => void;
}) {
  const visibleSessions = sessions.slice(0, 24);
  const pinned = visibleSessions.filter((session) => session.pinned);
  const groups = recentSessionsByPeriod(
    visibleSessions.filter((session) => !session.pinned),
    new Date(now),
  );
  const moreAvailable = sessions.length > 24;
  return (
    <main className="mobile-account-home" id="mobile-main" tabIndex={-1}>
      <section className="mobile-account-hero">
        <div className="mobile-hero-text">
          <p className="mobile-eyebrow">{providerLabel}</p>
          <h1 title={accountLabel}>{accountLabel}</h1>
          <p className="mobile-hero-meta" data-state={status.state}>
            <span className="mobile-flight-link" aria-hidden="true" />
            <span>{status.label}</span>
            <span aria-hidden="true">·</span>
            <span>
              {sessions.length} Session{sessions.length === 1 ? "" : "s"}
              {moreAvailable ? "+" : ""}
            </span>
          </p>
          {!status.canControl && status.reason !== null && (
            <p className="mobile-hero-notice" role="status">{status.reason}</p>
          )}
        </div>
        <div className="mobile-hero-actions">
          <button
            type="button"
            className="mobile-icon-button"
            aria-label="Search Sessions in this account"
            title="Search Sessions"
            onClick={onOpenDrawer}
          >
            <SearchIcon />
          </button>
        </div>
      </section>

      {pinned.length > 0 && (
        <section className="mobile-home-pinned" aria-label="Pinned Sessions">
          <h2>Pinned</h2>
          <ul>
            {pinned.map((session) => (
              <li key={`pinned-${session.key}`}>
                <SessionRow
                  session={session}
                  onOpenSession={onOpenSession}
                  onResumeNative={onResumeNative}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {sessions.length === 0 ? (
        <section className="mobile-home-empty">
          <h2>No Sessions</h2>
          <p>{status.canControl ? "Create or resume a Session under this account." : status.reason}</p>
        </section>
      ) : groups.length > 0 || moreAvailable ? (
        <div className="mobile-home-groups">
          {groups.map((group) => (
            <section key={group.period}>
              <h2>{group.period}</h2>
              <ul>
                {group.sessions.map((session) => (
                  <li key={session.key}>
                    <SessionRow
                      session={session}
                      onOpenSession={onOpenSession}
                      onResumeNative={onResumeNative}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {moreAvailable && (
            <p className="mobile-list-notice" role="status">More Sessions available — open search.</p>
          )}
        </div>
      ) : null}

      <button
        type="button"
        className="mobile-new-session"
        data-testid="mobile-new-session"
        disabled={!canCreate}
        title={createDisabledReason ?? "Create Session"}
        aria-label={createDisabledReason === null ? "Create new Session" : `Create unavailable: ${createDisabledReason}`}
        onClick={onCreate}
      >
        <PlusIcon />
        <span>New</span>
      </button>
    </main>
  );
}

function SessionRow({
  session,
  onOpenSession,
  onResumeNative,
}: {
  session: MobileSessionRow;
  onOpenSession: (sessionId: string) => void;
  onResumeNative: (providerSessionId: string) => void;
}) {
  const stateLabel = mobileSessionStateLabel(session.state);
  return (
    <button
      type="button"
      className="mobile-session-row"
      onClick={() => {
        if (session.sessionId !== null) onOpenSession(session.sessionId);
        else if (session.providerSessionId !== null) onResumeNative(session.providerSessionId);
      }}
    >
      <span className="mobile-session-state" data-state={session.state} aria-hidden="true" />
      <span className="mobile-row-copy">
        <strong title={session.title}>{session.title}</strong>
        <small>
          <span className="mobile-session-state-label">{stateLabel}</span>
          <span aria-hidden="true"> · </span>
          {session.projectName ?? "Project unavailable"}
          {session.pendingApprovalCount > 0 ? ` · ${session.pendingApprovalCount} approval` : ""}
        </small>
      </span>
    </button>
  );
}
