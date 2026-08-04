import { useEffect, useMemo, useState } from "react";

import { MoreIcon, SearchIcon } from "./icons.js";
import { mobileSessionStateLabel, recentSessionsByPeriod, type MobileSessionRow } from "./state.js";

function relativeActivity(value: string, now: number) {
  const elapsed = Math.max(0, now - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function AccountSessionList({
  sessions,
  search,
  loading,
  hasMore,
  truncated,
  now,
  selectedSessionId,
  onSearchChange,
  onSelectSession,
  onResumeNative,
  onOpenActions,
  onLoadMore,
}: {
  sessions: readonly MobileSessionRow[];
  search: string;
  loading: boolean;
  hasMore: boolean;
  truncated: boolean;
  now: number;
  selectedSessionId: string;
  onSearchChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onResumeNative: (providerSessionId: string) => void;
  onOpenActions: (session: MobileSessionRow) => void;
  onLoadMore: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(60);
  useEffect(() => setVisibleCount(60), [search, sessions[0]?.providerId, sessions[0]?.accountId]);
  const visible = sessions.slice(0, visibleCount);
  const groups = useMemo(() => recentSessionsByPeriod(visible, new Date(now)), [now, visible]);
  const localMore = visibleCount < sessions.length;

  return (
    <section className="mobile-session-list" aria-label="Sessions for selected account">
      <label className="mobile-search">
        <SearchIcon />
        <span className="sr-only">Search Sessions in selected account</span>
        <input
          type="search"
          value={search}
          placeholder="Search this account"
          data-testid="mobile-session-search"
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>
      {loading && sessions.length === 0 ? (
        <p className="mobile-empty" role="status">Loading Sessions…</p>
      ) : groups.length === 0 ? (
        <p className="mobile-empty">{search === "" ? "No Sessions in this account." : "No matching Sessions."}</p>
      ) : (
        <div className="mobile-session-groups">
          {groups.map((group) => (
            <section key={group.period} aria-labelledby={`mobile-period-${group.period.replaceAll(" ", "-")}`}>
              <h3 id={`mobile-period-${group.period.replaceAll(" ", "-")}`}>{group.period}</h3>
              <ul>
                {group.sessions.map((session) => (
                  <li key={session.key} className={session.sessionId === selectedSessionId ? "selected" : undefined}>
                    <button
                      type="button"
                      className="mobile-session-open"
                      title={session.title}
                      onClick={() => {
                        if (session.sessionId !== null) onSelectSession(session.sessionId);
                        else if (session.providerSessionId !== null) onResumeNative(session.providerSessionId);
                      }}
                    >
                      <span className="mobile-session-state" data-state={session.state} aria-hidden="true" />
                      <span className="mobile-row-copy">
                        <strong>{session.title}</strong>
                        <small>
                          {mobileSessionStateLabel(session.state)} · {session.projectName ?? "Project unavailable"}
                          {session.pinned ? " · Pinned" : ""}
                          {session.archived ? " · Archived" : ""}
                          {session.kind === "native" ? " · Native" : session.canControl ? " · Controllable" : " · View only"}
                        </small>
                      </span>
                      <time dateTime={session.lastActivityAt}>{relativeActivity(session.lastActivityAt, now)}</time>
                    </button>
                    {session.catalog !== null && (
                      <button
                        type="button"
                        className="mobile-icon-button mobile-more-button"
                        aria-label={`Session actions for ${session.title}`}
                        onClick={() => onOpenActions(session)}
                      >
                        <MoreIcon />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {(localMore || hasMore) && (
        <button
          type="button"
          className="mobile-load-more"
          data-testid="mobile-session-load-more"
          disabled={loading}
          onClick={() => {
            if (localMore) setVisibleCount((count) => count + 60);
            else onLoadMore();
          }}
        >
          {loading ? "Loading…" : localMore ? "Show more loaded Sessions" : "Load more Sessions"}
        </button>
      )}
      {truncated && !hasMore && (
        <p className="mobile-list-notice" role="status">This Session inventory is truncated. Refresh to check for more.</p>
      )}
    </section>
  );
}
