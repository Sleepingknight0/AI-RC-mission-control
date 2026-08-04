import { PlusIcon, SearchIcon } from "./icons.js";
import { recentSessionsByPeriod, type AccountStatus, type MobileSessionRow } from "./state.js";

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
  const groups = recentSessionsByPeriod(sessions.slice(0, 24), new Date(now));
  const pinned = sessions.filter((session) => session.pinned).slice(0, 6);
  const moreAvailable = sessions.length > 24;
  return (
    <main className="mobile-account-home" id="mobile-main" tabIndex={-1}>
      <div className="mobile-home-grid" aria-hidden="true" />
      <section className="mobile-account-hero">
        <span className="mobile-provider-mark large" aria-hidden="true">
          {providerLabel.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <p className="mobile-eyebrow">{providerLabel}</p>
          <h1 title={accountLabel}>{accountLabel}</h1>
          <span className="mobile-hero-status" data-state={status.state}>
            <span className="mobile-flight-link" aria-hidden="true" />
            {status.label}
            <span aria-hidden="true">·</span>
            {sessions.length} loaded Session{sessions.length === 1 ? "" : "s"}
            {moreAvailable ? " · more available" : ""}
          </span>
        </div>
      </section>

      <section className="mobile-home-command" aria-label="Mission prompt">
        <p className="mobile-home-greeting">Ready for the next Turn.</p>
        <p className="mobile-home-subcopy">
          {status.canControl
            ? "Open a Session or create one under this exact account. Drafts stay local until you send."
            : status.reason ?? "This account is not currently controllable."}
        </p>
      </section>

      <button type="button" className="mobile-home-search" onClick={onOpenDrawer}>
        <SearchIcon />
        Search Sessions in this account
      </button>

      {pinned.length > 0 && (
        <section className="mobile-home-pinned" aria-label="Pinned Sessions">
          <h2>Pinned</h2>
          <ul>
            {pinned.map((session) => (
              <li key={`pinned-${session.key}`}>
                <button
                  type="button"
                  onClick={() => {
                    if (session.sessionId !== null) onOpenSession(session.sessionId);
                    else if (session.providerSessionId !== null) onResumeNative(session.providerSessionId);
                  }}
                >
                  <strong title={session.title}>{session.title}</strong>
                  <small>{session.projectName ?? "Project unavailable"}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.length === 0 ? (
        <section className="mobile-home-empty">
          <h2>No Sessions yet</h2>
          <p>{status.canControl ? "Create a Session or resume a provider-native Session." : status.reason}</p>
        </section>
      ) : (
        <div className="mobile-home-groups">
          {groups.map((group) => (
            <section key={group.period}>
              <h2>{group.period}</h2>
              <ul>
                {group.sessions.map((session) => (
                  <li key={session.key}>
                    <button
                      type="button"
                      onClick={() => {
                        if (session.sessionId !== null) onOpenSession(session.sessionId);
                        else if (session.providerSessionId !== null) onResumeNative(session.providerSessionId);
                      }}
                    >
                      <span>
                        <strong title={session.title}>{session.title}</strong>
                        <small>
                          {session.projectName ?? "Project unavailable"}
                          {session.pendingApprovalCount > 0 ? ` · ${session.pendingApprovalCount} approval` : ""}
                        </small>
                      </span>
                      <span
                        className="mobile-session-state"
                        data-state={session.state}
                        aria-label={session.state.replaceAll("_", " ")}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {moreAvailable && (
            <p className="mobile-list-notice" role="status">
              Showing recent loaded Sessions. Open search for the full account inventory.
            </p>
          )}
        </div>
      )}

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
        <span>New Session</span>
      </button>
    </main>
  );
}
