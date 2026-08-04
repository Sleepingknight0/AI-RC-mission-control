import type { ReactNode, RefObject, UIEventHandler } from "react";

export function MobileChatTimeline({
  busy,
  loading,
  empty,
  unreadUpdates,
  timelineRef,
  onScroll,
  onReturnToLive,
  children,
}: {
  busy: boolean;
  loading: boolean;
  empty: boolean;
  unreadUpdates: number;
  timelineRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onReturnToLive: () => void;
  children: ReactNode;
}) {
  return (
    <section className="mobile-chat-timeline" aria-label="Session chat">
      <div
        className="mobile-timeline-scroll"
        ref={timelineRef}
        onScroll={onScroll}
        role="feed"
        aria-label="Session event timeline"
        aria-busy={busy || loading}
      >
        {loading ? (
          <div className="mobile-chat-empty" role="status">
            <span className="mobile-loading-mark" aria-hidden="true" />
            <p>Loading authoritative Session…</p>
          </div>
        ) : empty ? (
          <div className="mobile-chat-empty">
            <h2>Start a conversation</h2>
            <p>This Session has no turns yet. Your draft stays on this device until you send it.</p>
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
