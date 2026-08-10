import type { ReactNode, RefObject, UIEventHandler } from "react";

export function MobileChatTimeline({
  busy,
  loading,
  empty,
  providerNative,
  unavailable,
  unreadUpdates,
  timelineRef,
  onScroll,
  onReturnToLive,
  emptyTitle,
  emptyDetail,
  children,
}: {
  busy: boolean;
  loading: boolean;
  empty: boolean;
  providerNative: boolean;
  unavailable: boolean;
  unreadUpdates: number;
  timelineRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onReturnToLive: () => void;
  emptyTitle?: string;
  emptyDetail?: string;
  children: ReactNode;
}) {
  return (
    <section className="mobile-chat-timeline" aria-label="Session chat">
      <div
        className="mobile-timeline-scroll"
        ref={timelineRef}
        onScroll={onScroll}
        role="feed"
        tabIndex={0}
        aria-label="Session event timeline"
        aria-busy={busy || loading}
      >
        {loading ? (
          <div className="mobile-chat-empty" role="status">
            <span className="mobile-loading-mark" aria-hidden="true" />
            <p>Loading authoritative Session…</p>
          </div>
        ) : unavailable ? (
          <div className="mobile-chat-empty" role="status">
            <h2>Provider history unavailable</h2>
            <p>Remote activity could not be read. AICL did not send or replay a prompt.</p>
          </div>
        ) : empty ? (
          <div className="mobile-chat-empty">
            <h2>{emptyTitle ?? (providerNative ? "No provider history yet" : "Start a conversation")}</h2>
            <p>
              {emptyDetail ?? (providerNative
                ? "The provider returned no visible history for this Session."
                : "This Session has no turns yet. Your draft stays on this device until you send it.")}
            </p>
          </div>
        ) : children}
      </div>
      {unreadUpdates > 0 && (
        <button type="button" className="mobile-return-live" onClick={onReturnToLive}>
          {unreadUpdates} new {unreadUpdates === 1 ? "update" : "updates"} · Return to live
        </button>
      )}
    </section>
  );
}
