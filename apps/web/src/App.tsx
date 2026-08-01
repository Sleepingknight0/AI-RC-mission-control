import {
  PROTOCOL_VERSION,
  ServerEnvelopeSchema,
  makeEnvelope,
  type Approval,
  type FileChange,
  type Runtime,
  type SessionSnapshot,
  type SessionSummary,
  type ToolActivity,
} from "@aicl/protocol";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import {
  buildTimeline,
  durableSeq,
  latestTurn,
  turnAvailability,
  updateSnapshot,
  type ConnectionState,
  type TimelineItem,
} from "./state.js";

const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const requestedSessionId = new URLSearchParams(window.location.search).get("session");
const INITIAL_SESSION_ID =
  requestedSessionId !== null && SESSION_PATTERN.test(requestedSessionId)
    ? requestedSessionId
    : "session-demo";
const CORE_URL = import.meta.env.VITE_CORE_WS_URL ?? "ws://127.0.0.1:8787/ws";
const CORE_HTTP_ORIGIN = new URL(CORE_URL).origin.replace(/^ws/, "http");
const DEVICE_KEY = "aicl:device-id";

function cursorKey(sessionId: string) {
  return `aicl:last-event-seq:${sessionId}`;
}

function draftKey(sessionId: string) {
  return `aicl:draft:${sessionId}`;
}

function readCursor(sessionId: string) {
  return Number.parseInt(sessionStorage.getItem(cursorKey(sessionId)) ?? "0", 10) || 0;
}

function deviceId() {
  const existing = sessionStorage.getItem(DEVICE_KEY);
  if (existing !== null) return existing;
  const created = `web-${crypto.randomUUID()}`;
  sessionStorage.setItem(DEVICE_KEY, created);
  return created;
}

function formatState(value: string) {
  return value.replaceAll("_", " ").toUpperCase();
}

function formatTime(value: string | null | undefined) {
  if (value == null) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatElapsed(startedAt: string | undefined, now: number) {
  if (startedAt === undefined) return "00:00";
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function splitDiff(content: string) {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) {
      before.push(line);
      after.push("");
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      before.push("");
      after.push(line);
    } else {
      before.push(line);
      after.push(line);
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

async function sha256Hex(content: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function connectionLabel(connection: ConnectionState) {
  if (connection === "online") return "Core online";
  if (connection === "syncing") return "Replaying durable state";
  if (connection === "reconnecting") return "Reconnecting to Core";
  if (connection === "offline") return "Core offline";
  return "Connecting to Core";
}

function StatusPill({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`status-pill state-${value}`} aria-label={label ?? formatState(value)}>
      <span className="status-mark" aria-hidden="true" />
      {label ?? formatState(value)}
    </span>
  );
}

function ActivityBlock({ activity }: { activity: ToolActivity }) {
  return (
    <details className="activity-block" open={activity.status === "running"}>
      <summary>
        <span>
          <small>{activity.kind.toUpperCase()}</small>
          <strong>{activity.title}</strong>
        </span>
        <StatusPill value={activity.status} />
      </summary>
      <dl className="compact-facts">
        <div><dt>Working directory</dt><dd>{activity.cwd ?? "Unavailable"}</dd></div>
        <div><dt>Exit code</dt><dd>{activity.exitCode ?? "—"}</dd></div>
        <div><dt>Duration</dt><dd>{activity.durationMs == null ? "—" : `${activity.durationMs} ms`}</dd></div>
      </dl>
      <pre>{activity.outputPreview || "No output captured."}</pre>
    </details>
  );
}

function TimelineEntry({
  item,
  onInspectFileChange,
}: {
  item: TimelineItem;
  onInspectFileChange: (fileChangeId: string) => void;
}) {
  if (item.kind === "operator") {
    return (
      <article className="timeline-entry operator-entry" data-state={item.turn.status}>
        <div className="entry-meta">
          <span>OPERATOR</span>
          <time dateTime={item.turn.startedAt}>{formatTime(item.turn.startedAt)}</time>
        </div>
        <p>{item.turn.prompt}</p>
        <StatusPill value={item.turn.status} />
      </article>
    );
  }
  if (item.kind === "assistant") {
    return (
      <article className="timeline-entry assistant-entry">
        <div className="entry-meta">
          <span>ASSISTANT</span>
          <span>{item.completed ? "AUTHORITATIVE" : "STREAMING"}</span>
        </div>
        <p className="assistant-copy">{item.content || "Waiting for first token…"}</p>
      </article>
    );
  }
  if (item.kind === "activity") {
    return (
      <article className="timeline-entry machine-entry">
        <ActivityBlock activity={item.activity} />
      </article>
    );
  }
  return (
    <article className="timeline-entry file-entry">
      <div className="entry-meta">
        <span>FILE CHANGE</span>
        <StatusPill value={item.fileChange.status} />
      </div>
      <p className="path-list">
        {item.fileChange.files.map((file) => `${file.kind[0]?.toUpperCase()} ${file.path}`).join("\n")}
      </p>
      <div className="file-entry-footer">
        <span><b>+{item.fileChange.additions}</b> / −{item.fileChange.deletions}</span>
        <button type="button" className="text-button" onClick={() => onInspectFileChange(item.fileChange.fileChangeId)}>
          Inspect diff
        </button>
      </div>
    </article>
  );
}

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const selectedSessionRef = useRef(INITIAL_SESSION_ID);
  const outputSeqRef = useRef(new Map<string, number>());
  const approvalCommandsRef = useRef(
    new Map<string, { approvalId: string; commandId: string }>(),
  );
  const lastSeenSeqRef = useRef(readCursor(INITIAL_SESSION_ID));
  const connectedBeforeRef = useRef(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineAtBottomRef = useRef(true);
  const previousTimelineSignalRef = useRef("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState(INITIAL_SESSION_ID);
  const [sessionInput, setSessionInput] = useState(INITIAL_SESSION_ID);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [prompt, setPrompt] = useState(
    sessionStorage.getItem(draftKey(INITIAL_SESSION_ID)) ?? "",
  );
  const [notice, setNotice] = useState("Waiting for Core snapshot…");
  const [artifactAccessToken, setArtifactAccessToken] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [selectedFileChangeId, setSelectedFileChangeId] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [wrapDiff, setWrapDiff] = useState(false);
  const [artifactText, setArtifactText] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [unreadUpdates, setUnreadUpdates] = useState(0);
  const [now, setNow] = useState(Date.now());

  const subscribe = (socket: WebSocket, sessionId: string) => {
    lastSeenSeqRef.current = readCursor(sessionId);
    outputSeqRef.current.clear();
    socket.send(JSON.stringify(makeEnvelope("sessions.list", {})));
    socket.send(
      JSON.stringify(
        makeEnvelope("session.subscribe", {
          sessionId,
          afterSeq: lastSeenSeqRef.current,
        }),
      ),
    );
  };

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;

    const connect = () => {
      if (disposed) return;
      setConnection(connectedBeforeRef.current ? "reconnecting" : "connecting");
      const socket = new WebSocket(CORE_URL);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        connectedBeforeRef.current = true;
        reconnectAttempt = 0;
        setConnection("syncing");
        socket.send(
          JSON.stringify(
            makeEnvelope("client.hello", {
              clientName: "aicl-web",
              supportedProtocolVersions: [PROTOCOL_VERSION],
            }),
          ),
        );
        subscribe(socket, selectedSessionRef.current);
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(event.data) as unknown;
        } catch {
          setNotice("Core sent malformed JSON. The frame was ignored.");
          return;
        }
        const parsed = ServerEnvelopeSchema.safeParse(decoded);
        if (!parsed.success) {
          setNotice("Core sent an invalid normalized envelope. The frame was ignored.");
          return;
        }
        const message = parsed.data;
        if (message.type === "server.hello") {
          setArtifactAccessToken(message.payload.artifactAccessToken);
        }
        if (message.type === "sessions.snapshot") setSessions(message.payload.sessions);
        if (message.type === "runtime.status") setRuntime(message.payload.runtime);
        if (message.type === "command.accepted") {
          setNotice(`Command accepted · ${message.payload.commandId}`);
        }
        if (message.type === "command.rejected") {
          setNotice(`${message.payload.error.code}: ${message.payload.error.message}`);
          const command = approvalCommandsRef.current.get(message.payload.commandId);
          if (command !== undefined) {
            setResolving((current) => {
              const next = new Set(current);
              next.delete(command.approvalId);
              return next;
            });
          }
        }
        if (message.type === "protocol.error") {
          setNotice(`${message.payload.error.code}: ${message.payload.error.message}`);
        }
        if (
          message.type === "approval.resolved" ||
          message.type === "approval.expired" ||
          message.type === "approval.invalidated"
        ) {
          setResolving((current) => {
            const next = new Set(current);
            next.delete(message.payload.approval.approvalId);
            return next;
          });
        }
        if (message.type === "command.output.batch") {
          const previous = outputSeqRef.current.get(message.payload.activityId) ?? 0;
          if (message.payload.streamSeq <= previous) return;
          outputSeqRef.current.set(message.payload.activityId, message.payload.streamSeq);
        }
        if (
          message.type === "replay.boundary" &&
          message.payload.sessionId === selectedSessionRef.current
        ) {
          if (message.payload.phase === "begin") setConnection("syncing");
          else {
            lastSeenSeqRef.current = Math.max(
              lastSeenSeqRef.current,
              message.payload.upperBoundSeq,
            );
            sessionStorage.setItem(
              cursorKey(selectedSessionRef.current),
              String(lastSeenSeqRef.current),
            );
            setConnection("online");
            setNotice(`Synchronized through event ${message.payload.upperBoundSeq}`);
          }
        }
        const seq = durableSeq(message);
        const payloadSessionId =
          "sessionId" in message.payload && typeof message.payload.sessionId === "string"
            ? message.payload.sessionId
            : message.type === "session.snapshot"
              ? message.payload.snapshot.sessionId
              : null;
        if (payloadSessionId === selectedSessionRef.current) {
          if (seq !== null && seq > lastSeenSeqRef.current) {
            lastSeenSeqRef.current = seq;
            sessionStorage.setItem(cursorKey(payloadSessionId), String(seq));
          }
          setSnapshot((current) => updateSnapshot(current, message));
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setConnection("offline");
        setArtifactAccessToken(null);
        setNotice("Core connection lost. Draft retained; no command will auto-send.");
        reconnectAttempt += 1;
        const delay = Math.min(5_000, 500 * 2 ** Math.min(reconnectAttempt - 1, 3));
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const timelineItems = useMemo(() => buildTimeline(snapshot), [snapshot]);
  const timelineSignal = `${snapshot?.lastEventSeq ?? 0}:${snapshot?.messages
    .map((message) => message.content.length)
    .join(",")}:${snapshot?.activities.map((activity) => activity.outputPreview.length).join(",")}`;

  useEffect(() => {
    const container = timelineRef.current;
    if (container === null || timelineSignal === previousTimelineSignalRef.current) return;
    const hadPrevious = previousTimelineSignalRef.current !== "";
    previousTimelineSignalRef.current = timelineSignal;
    if (timelineAtBottomRef.current || !hadPrevious) {
      container.scrollTop = container.scrollHeight;
      setUnreadUpdates(0);
    } else {
      setUnreadUpdates((count) => count + 1);
    }
  }, [timelineSignal]);

  useEffect(() => {
    const available = snapshot?.fileChanges ?? [];
    if (
      selectedFileChangeId === null ||
      !available.some((item) => item.fileChangeId === selectedFileChangeId)
    ) {
      setSelectedFileChangeId(available.at(-1)?.fileChangeId ?? null);
    }
  }, [selectedFileChangeId, snapshot?.fileChanges]);

  const switchSession = (sessionId: string) => {
    if (!SESSION_PATTERN.test(sessionId)) {
      setNotice("Session ID must use 1–100 letters, numbers, dots, dashes, or underscores.");
      return;
    }
    selectedSessionRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setSessionInput(sessionId);
    setSnapshot(null);
    setSelectedFileChangeId(null);
    setArtifactText(null);
    setArtifactError(null);
    setUnreadUpdates(0);
    previousTimelineSignalRef.current = "";
    timelineAtBottomRef.current = true;
    setPrompt(sessionStorage.getItem(draftKey(sessionId)) ?? "");
    const url = new URL(window.location.href);
    url.searchParams.set("session", sessionId);
    window.history.replaceState(null, "", url);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      setConnection("syncing");
      subscribe(socket, sessionId);
    }
  };

  const openSession = (event: FormEvent) => {
    event.preventDefault();
    switchSession(sessionInput.trim());
  };

  const availability = turnAvailability(connection, runtime, snapshot);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    const socket = socketRef.current;
    if (!availability.canSubmit || value === "" || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    const commandId = crypto.randomUUID();
    socket.send(
      JSON.stringify(
        makeEnvelope("turn.submit", {
          commandId,
          sessionId: selectedSessionId,
          prompt: value,
        }),
      ),
    );
    sessionStorage.removeItem(draftKey(selectedSessionId));
    setPrompt("");
    setNotice(`Dispatching command · ${commandId}`);
  };

  const updateDraft = (value: string) => {
    setPrompt(value);
    if (value === "") sessionStorage.removeItem(draftKey(selectedSessionId));
    else sessionStorage.setItem(draftKey(selectedSessionId), value);
  };

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const interrupt = () => {
    const socket = socketRef.current;
    const turnId = snapshot?.activeTurnId;
    if (turnId == null || socket?.readyState !== WebSocket.OPEN) return;
    const commandId = crypto.randomUUID();
    socket.send(
      JSON.stringify(
        makeEnvelope("turn.interrupt", {
          commandId,
          sessionId: selectedSessionId,
          turnId,
        }),
      ),
    );
    setNotice(`Interrupt requested · ${turnId}`);
  };

  const resolveApproval = (
    approval: Approval,
    decision: "approved_once" | "declined",
  ) => {
    const socket = socketRef.current;
    if (connection !== "online" || socket?.readyState !== WebSocket.OPEN) return;
    const key = `${approval.approvalId}:${decision}`;
    const existing = approvalCommandsRef.current.get(key);
    const commandId = existing?.commandId ?? crypto.randomUUID();
    approvalCommandsRef.current.set(key, { approvalId: approval.approvalId, commandId });
    socket.send(
      JSON.stringify(
        makeEnvelope("approval.resolve", {
          commandId,
          sessionId: selectedSessionId,
          approvalId: approval.approvalId,
          expectedRevision: approval.revision,
          decision,
          deviceId: deviceId(),
        }),
      ),
    );
    setResolving((current) => new Set(current).add(approval.approvalId));
    setNotice(`${formatState(decision)} requested · ${approval.approvalId}`);
  };

  const selectedFileChange =
    snapshot?.fileChanges.find((item) => item.fileChangeId === selectedFileChangeId) ??
    null;

  const loadArtifact = async (fileChange: FileChange) => {
    if (fileChange.diff?.kind !== "artifact" || artifactAccessToken === null) return;
    setArtifactLoading(true);
    setArtifactError(null);
    try {
      const response = await fetch(
        `${CORE_HTTP_ORIGIN}${fileChange.diff.artifact.downloadPath}`,
        { headers: { Authorization: `Bearer ${artifactAccessToken}` } },
      );
      if (!response.ok) throw new Error(`Artifact request failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      const digest = await sha256Hex(bytes);
      if (
        digest !== fileChange.diff.artifact.sha256 ||
        bytes.byteLength !== fileChange.diff.artifact.byteLength
      ) {
        throw new Error("Artifact integrity check failed");
      }
      setArtifactText(new TextDecoder().decode(bytes));
      setNotice(`Verified artifact · ${fileChange.diff.artifact.artifactId}`);
    } catch (error) {
      setArtifactError(error instanceof Error ? error.message : "Artifact load failed");
    } finally {
      setArtifactLoading(false);
    }
  };

  const inspectFileChange = (fileChangeId: string) => {
    setSelectedFileChangeId(fileChangeId);
    setArtifactText(null);
    setArtifactError(null);
    document.querySelector<HTMLElement>("#diff-review")?.focus({ preventScroll: false });
  };

  const returnToLive = () => {
    const container = timelineRef.current;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
    timelineAtBottomRef.current = true;
    setUnreadUpdates(0);
  };

  const onTimelineScroll = () => {
    const container = timelineRef.current;
    if (container === null) return;
    timelineAtBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 64;
    if (timelineAtBottomRef.current) setUnreadUpdates(0);
  };

  const pendingApprovals =
    snapshot?.approvals
      .filter((approval) => approval.state === "pending")
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt)) ?? [];
  const currentSummary = sessions.find((item) => item.sessionId === selectedSessionId);
  const latest = latestTurn(snapshot);
  const sessionState =
    pendingApprovals.length > 0
      ? "awaiting_approval"
      : currentSummary?.state ?? latest?.status ?? "idle";
  const activeCount = sessions.filter(
    (item) => item.state === "running" || item.state === "awaiting_approval",
  ).length;
  const degradedCount = sessions.filter(
    (item) =>
      item.state === "failed" ||
      item.state === "outcome_unknown" ||
      item.runtimeStatus === "lost" ||
      item.runtimeStatus === "incompatible",
  ).length;
  const approvalCount = sessions.reduce(
    (total, item) => total + item.pendingApprovalCount,
    0,
  );
  const timelineBusy = latest?.status === "running";
  const recoveryRequired =
    runtime?.status === "lost" || latest?.status === "outcome_unknown";
  const displayedDiff =
    selectedFileChange?.diff?.kind === "inline"
      ? selectedFileChange.diff.content
      : artifactText;
  const split = useMemo(
    () => (displayedDiff === null ? null : splitDiff(displayedDiff)),
    [displayedDiff],
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#session-console">Skip to Session Console</a>

      <header className="command-bar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">A</span>
          <div>
            <p className="eyebrow">AICL / PROTOTYPE 0</p>
            <h1>Mission Control</h1>
          </div>
        </div>
        <div className="system-strip" aria-label="System connection status">
          <StatusPill value={connection} label={connectionLabel(connection)} />
          <StatusPill
            value={runtime?.status ?? "offline"}
            label={`Connector ${runtime?.status ?? "unavailable"}`}
          />
          <time className="clock" dateTime={new Date(now).toISOString()}>
            {new Intl.DateTimeFormat(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short",
            }).format(now)}
          </time>
        </div>
      </header>

      <section className="mission-overview" aria-labelledby="overview-title">
        <div>
          <p className="eyebrow">OPERATIONAL PICTURE</p>
          <h2 id="overview-title">Mission Overview</h2>
        </div>
        <dl className="mission-metrics">
          <div><dt>Sessions</dt><dd>{sessions.length.toString().padStart(2, "0")}</dd></div>
          <div><dt>Active</dt><dd>{activeCount.toString().padStart(2, "0")}</dd></div>
          <div><dt>Approval</dt><dd>{approvalCount.toString().padStart(2, "0")}</dd></div>
          <div><dt>Degraded</dt><dd>{degradedCount.toString().padStart(2, "0")}</dd></div>
        </dl>
      </section>

      <div className="workspace">
        <aside className="session-rail" aria-labelledby="sessions-title">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">MISSION INDEX</p>
              <h2 id="sessions-title">Sessions</h2>
            </div>
            <span className="mono-meta">{sessions.length}</span>
          </div>
          <div className="session-list">
            {sessions.length > 0 ? (
              sessions.map((session) => (
                <button
                  type="button"
                  key={session.sessionId}
                  className={`session-strip ${session.sessionId === selectedSessionId ? "selected" : ""}`}
                  aria-current={session.sessionId === selectedSessionId ? "page" : undefined}
                  onClick={() => switchSession(session.sessionId)}
                >
                  <span className="session-strip-top">
                    <span className="provider-label">CODEX</span>
                    <StatusPill value={session.state} />
                  </span>
                  <strong>{session.sessionId}</strong>
                  <span className="session-path">{session.cwd ?? "Project path unavailable"}</span>
                  <span className="session-strip-bottom">
                    <span>{session.turnCount} turns</span>
                    <span>{session.pendingApprovalCount} approvals</span>
                    <time dateTime={session.lastActivityAt}>{formatTime(session.lastActivityAt)}</time>
                  </span>
                </button>
              ))
            ) : (
              <p className="empty-state">No durable Sessions yet. Open a Session ID below.</p>
            )}
          </div>
          <form className="open-session" onSubmit={openSession}>
            <label htmlFor="session-id">Open Session ID</label>
            <div>
              <input
                id="session-id"
                value={sessionInput}
                onChange={(event) => setSessionInput(event.target.value)}
                autoComplete="off"
              />
              <button type="submit">Open</button>
            </div>
          </form>
        </aside>

        <main className="session-console" id="session-console" tabIndex={-1}>
          <header className="console-header">
            <div>
              <p className="eyebrow">SESSION CONSOLE</p>
              <h2>{selectedSessionId}</h2>
              <p className="console-path">{currentSummary?.cwd ?? "Project path unavailable"}</p>
            </div>
            <div className="console-state">
              <StatusPill value={sessionState} />
              <span className="mono-meta">
                RUNTIME G{runtime?.generation ?? "—"} · {formatElapsed(latest?.startedAt, now)}
              </span>
            </div>
          </header>

          <label className="mobile-session-picker">
            Session
            <select value={selectedSessionId} onChange={(event) => switchSession(event.target.value)}>
              {sessions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>{session.sessionId}</option>
              ))}
              {!sessions.some((session) => session.sessionId === selectedSessionId) && (
                <option value={selectedSessionId}>{selectedSessionId}</option>
              )}
            </select>
          </label>

          {connection !== "online" && (
            <section className="state-banner connection-banner" role="status">
              <strong>{connectionLabel(connection)}</strong>
              <p>Your unsent draft stays local. A reconnect never dispatches it automatically.</p>
            </section>
          )}

          {recoveryRequired && (
            <section className="state-banner recovery-banner" role="alert">
              <div>
                <p className="eyebrow">OPERATOR REVIEW REQUIRED</p>
                <h3>{latest?.status === "outcome_unknown" ? "Turn outcome unknown" : "Runtime ownership lost"}</h3>
              </div>
              <dl className="recovery-facts">
                <div><dt>Known</dt><dd>Last durable event is {snapshot?.lastEventSeq ?? 0}.</dd></div>
                <div><dt>Unknown</dt><dd>Provider side effects may not have a proven terminal result.</dd></div>
                <div><dt>System will not</dt><dd>Replay or resend the original prompt automatically.</dd></div>
              </dl>
              <button type="button" className="secondary-button" onClick={() => document.querySelector<HTMLElement>("#diff-review")?.focus()}>
                Inspect file changes
              </button>
            </section>
          )}

          <section className="timeline-panel" aria-labelledby="timeline-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">NORMALIZED EVENTS</p>
                <h3 id="timeline-title">Timeline</h3>
              </div>
              <span className="mono-meta">SEQ {snapshot?.lastEventSeq ?? 0}</span>
            </div>
            <div
              className="timeline"
              ref={timelineRef}
              onScroll={onTimelineScroll}
              aria-busy={timelineBusy}
            >
              {snapshot === null ? (
                <div className="loading-state" role="status">
                  <span className="loading-line" />
                  <span className="loading-line short" />
                  <p>Loading authoritative Session projection…</p>
                </div>
              ) : timelineItems.length > 0 ? (
                timelineItems.map((item) => (
                  <TimelineEntry
                    key={item.id}
                    item={item}
                    onInspectFileChange={inspectFileChange}
                  />
                ))
              ) : (
                <div className="empty-state timeline-empty">
                  <strong>No turns in this Session</strong>
                  <p>Submit a prompt to start the first normalized event stream.</p>
                </div>
              )}
            </div>
            {unreadUpdates > 0 && (
              <button type="button" className="return-live" onClick={returnToLive}>
                {unreadUpdates} new {unreadUpdates === 1 ? "update" : "updates"} · Return to live
              </button>
            )}
          </section>

          <form onSubmit={submit} className="composer">
            <div className="composer-heading">
              <label htmlFor="prompt">Command prompt</label>
              <span className="mono-meta">CTRL / CMD + ENTER</span>
            </div>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              rows={4}
              placeholder="Describe the next bounded operation…"
              aria-describedby="composer-help"
            />
            <div className="composer-footer">
              <small id="composer-help">{availability.reason} Drafts never auto-send.</small>
              <div className="actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={snapshot?.activeTurnId == null || connection !== "online"}
                  onClick={interrupt}
                >
                  Stop turn
                </button>
                <button type="submit" disabled={!availability.canSubmit || prompt.trim() === ""}>
                  Dispatch
                </button>
              </div>
            </div>
          </form>
        </main>

        <aside className="inspector" aria-label="Session inspector">
          <section className="inspector-panel health-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">SYSTEM HEALTH</p>
                <h2>Live boundaries</h2>
              </div>
            </div>
            <dl className="health-list">
              <div><dt>Core</dt><dd><StatusPill value={connection} /></dd></div>
              <div><dt>Connector</dt><dd><StatusPill value={runtime?.status ?? "offline"} /></dd></div>
              <div><dt>Protocol</dt><dd>v{PROTOCOL_VERSION}</dd></div>
              <div><dt>Runtime</dt><dd>{runtime?.runtimeId ?? "Unavailable"}</dd></div>
              <div><dt>Generation</dt><dd>{runtime?.generation ?? "—"}</dd></div>
              <div><dt>Durable seq</dt><dd>{snapshot?.lastEventSeq ?? 0}</dd></div>
            </dl>
          </section>

          <section className="inspector-panel diff-panel" id="diff-review" tabIndex={-1}>
            <div className="panel-heading diff-heading">
              <div>
                <p className="eyebrow">FILE REVIEW</p>
                <h2>Diff Review</h2>
              </div>
              <span className="mono-meta">{snapshot?.fileChanges.length ?? 0} changes</span>
            </div>
            {snapshot?.fileChanges.length ? (
              <>
                <label className="field-label" htmlFor="file-change">File change</label>
                <select
                  id="file-change"
                  value={selectedFileChangeId ?? ""}
                  onChange={(event) => {
                    setSelectedFileChangeId(event.target.value);
                    setArtifactText(null);
                    setArtifactError(null);
                  }}
                >
                  {snapshot.fileChanges.map((fileChange) => (
                    <option key={fileChange.fileChangeId} value={fileChange.fileChangeId}>
                      {fileChange.files[0]?.path ?? fileChange.fileChangeId}
                    </option>
                  ))}
                </select>
                {selectedFileChange !== null && (
                  <>
                    <div className="diff-summary">
                      <span>{selectedFileChange.files.length} files</span>
                      <span><b>+{selectedFileChange.additions}</b> / −{selectedFileChange.deletions}</span>
                      <StatusPill value={selectedFileChange.status} />
                    </div>
                    <div className="diff-controls" aria-label="Diff display options">
                      <div className="segmented">
                        <button
                          className={diffMode === "unified" ? "selected" : ""}
                          type="button"
                          aria-pressed={diffMode === "unified"}
                          onClick={() => setDiffMode("unified")}
                        >
                          Unified
                        </button>
                        <button
                          className={diffMode === "split" ? "selected" : ""}
                          type="button"
                          aria-pressed={diffMode === "split"}
                          onClick={() => setDiffMode("split")}
                        >
                          Side by side
                        </button>
                      </div>
                      <label className="check-control">
                        <input type="checkbox" checked={wrapDiff} onChange={(event) => setWrapDiff(event.target.checked)} />
                        Wrap lines
                      </label>
                    </div>
                    {selectedFileChange.diff?.kind === "artifact" && artifactText === null && (
                      <div className="artifact-callout">
                        <p>
                          Large diff · {selectedFileChange.diff.artifact.byteLength.toLocaleString()} bytes · hash verification required
                        </p>
                        <button
                          type="button"
                          disabled={artifactAccessToken === null || artifactLoading}
                          onClick={() => void loadArtifact(selectedFileChange)}
                        >
                          {artifactLoading ? "Verifying…" : "Load verified diff"}
                        </button>
                        {artifactError !== null && <p className="inline-error" role="alert">{artifactError}</p>}
                      </div>
                    )}
                    {displayedDiff !== null ? (
                      diffMode === "unified" ? (
                        <pre className={`diff-content ${wrapDiff ? "wrap" : ""}`}>{displayedDiff}</pre>
                      ) : (
                        <div className={`split-diff ${wrapDiff ? "wrap" : ""}`}>
                          <pre>{split?.before}</pre>
                          <pre>{split?.after}</pre>
                        </div>
                      )
                    ) : selectedFileChange.diff === null ? (
                      <p className="empty-state">Diff metadata is unavailable.</p>
                    ) : null}
                  </>
                )}
              </>
            ) : (
              <p className="empty-state">No file changes in this Session.</p>
            )}
          </section>
        </aside>
      </div>

      <div className="notice-bar" role="status" aria-live="polite">{notice}</div>

      {pendingApprovals.length > 0 && (
        <aside className="approval-dock" aria-label="Pending approvals" aria-live="assertive">
          <div className="approval-dock-heading">
            <div>
              <p className="eyebrow">OPERATOR DECISION</p>
              <h2>Approval Dock</h2>
            </div>
            <span className="mono-meta">{pendingApprovals.length} pending</span>
          </div>
          <div className="approval-list">
            {pendingApprovals.map((approval) => {
              const disabled = connection !== "online" || resolving.has(approval.approvalId);
              return (
                <article key={approval.approvalId}>
                  <div className="approval-copy">
                    <span className="approval-type">{formatState(approval.actionType)}</span>
                    <h3>{approval.payload.summary}</h3>
                    {approval.payload.command &&
                      approval.payload.command !== approval.payload.summary && (
                        <code>{approval.payload.command}</code>
                      )}
                    <dl className="approval-facts">
                      <div><dt>Working directory</dt><dd>{approval.payload.cwd ?? "Unavailable"}</dd></div>
                      <div><dt>Runtime</dt><dd>G{approval.runtimeGeneration}</dd></div>
                      <div><dt>Expires</dt><dd>{formatTime(approval.expiresAt)}</dd></div>
                    </dl>
                    {approval.payload.reason && <p className="approval-reason">{approval.payload.reason}</p>}
                  </div>
                  <div className="actions approval-actions">
                    <button
                      className="danger-button"
                      type="button"
                      disabled={disabled}
                      onClick={() => resolveApproval(approval, "declined")}
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => resolveApproval(approval, "approved_once")}
                    >
                      {resolving.has(approval.approvalId) ? "Resolving…" : "Approve once"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {connection !== "online" && (
            <p className="dock-lock">Decisions are locked until authoritative replay completes.</p>
          )}
        </aside>
      )}
    </div>
  );
}
