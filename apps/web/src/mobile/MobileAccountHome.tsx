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
  return (
    <main className="mobile-account-home" id="mobile-main" tabIndex={-1}>
      <section className="mobile-account-hero">
        <span className="mobile-provider-mark large" aria-hidden="true">{providerLabel.slice(0, 1).toUpperCase()}</span>
        <div>
          <p>{providerLabel}</p>
          <h1 title={accountLabel}>{accountLabel}</h1>
          <span data-state={status.state}>{status.label} · {sessions.length} loaded Sessions</span>
        </div>
      </section>
      <button type="button" className="mobile-home-search" onClick={onOpenDrawer}>
        <SearchIcon />
        Search Sessions in this account
      </button>
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
                        <small>{session.projectName ?? "Project unavailable"}</small>
                      </span>
                      <span className="mobile-session-state" data-state={session.state} aria-label={session.state.replaceAll("_", " ")} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
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
