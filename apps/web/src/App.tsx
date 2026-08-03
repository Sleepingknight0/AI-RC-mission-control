import {
  INPUT_ATTACHMENT_CHUNK_BYTES,
  MAX_INPUT_ATTACHMENTS_PER_TURN,
  PROTOCOL_VERSION,
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type Approval,
  type FileChange,
  type Runtime,
  type SessionSettings,
  type SessionSnapshot,
  type SessionSummary,
  type ToolActivity,
} from "@aicl/protocol";
import {
  useCallback,
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
  approvalForRejectedCommand,
  trackApprovalCommand,
  TIMELINE_VIRTUALIZATION_THRESHOLD,
  TIMELINE_VIRTUAL_ROW_HEIGHT,
  turnAvailability,
  updateSnapshot,
  virtualTimelineWindow,
  type ConnectionState,
  type TimelineItem,
} from "./state.js";
import {
  requestBrowserRuntimeConfig,
  resolveCoreWebSocketUrl,
} from "./runtime.js";
import {
  attachmentKindForMediaType,
  basenameOnly,
  capabilitySupported,
  catalogRequestStarted,
  controllableProviders,
  defaultCatalogFilters,
  initialAttachmentState,
  initialCatalogState,
  initialFleetState,
  initialLeaseState,
  initialNativeState,
  initialSettingsState,
  reduceAttachments,
  reduceCatalog,
  reduceFleet,
  reduceLease,
  reduceNative,
  reduceSettings,
} from "./m9/state.js";
import {
  AttachmentComposer,
  CreateSessionForm,
  ProviderFleetPanel,
  SessionCatalogPanel,
  SessionControlsPanel,
  TerminalActivityDetails,
} from "./m9/ui.js";

const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const requestedSessionId = new URLSearchParams(window.location.search).get("session");
const INITIAL_SESSION_ID =
  requestedSessionId !== null && SESSION_PATTERN.test(requestedSessionId)
    ? requestedSessionId
    : "session-demo";
const CORE_URL = resolveCoreWebSocketUrl(
  import.meta.env.VITE_CORE_WS_URL,
  window.location,
);
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

function StatusPill({
  value,
  label,
  pulse = false,
}: {
  value: string;
  label?: string;
  pulse?: boolean;
}) {
  const busy =
    pulse ||
    value === "running" ||
    value === "syncing" ||
    value === "connecting" ||
    value === "reconnecting" ||
    value === "busy";
  return (
    <span
      className={`status-pill state-${value}${busy ? " is-busy" : ""}`}
      aria-label={label ?? formatState(value)}
    >
      <span className="status-mark" aria-hidden="true" />
      <span className="status-pill-text">{label ?? formatState(value)}</span>
    </span>
  );
}

function ThinkingOrb({
  label = "Thinking",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div className={`thinking-orb${compact ? " thinking-orb-compact" : ""}`} role="status">
      <span className="thinking-spin" aria-hidden="true">
        <span className="thinking-ring" />
        <span className="thinking-core" />
      </span>
      <span className="thinking-label">{label}</span>
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function ActivityBlock({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(activity.status === "running");
  const running = activity.status === "running";
  return (
    <details
      className={`activity-block${running ? " activity-running" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="activity-summary-copy">
          <small>{activity.kind.toUpperCase()}</small>
          <strong title={activity.title}>{activity.title}</strong>
        </span>
        <StatusPill value={activity.status} pulse={running} />
      </summary>
      <TerminalActivityDetails
        activity={{
          title: activity.title,
          command: activity.command ?? null,
          cwdLabel: activity.cwdLabel ?? activity.cwd,
          stdoutPreview: activity.stdoutPreview ?? activity.outputPreview,
          stderrPreview: activity.stderrPreview ?? "",
          stdoutTruncated: activity.stdoutTruncated ?? false,
          stderrTruncated: activity.stderrTruncated ?? false,
          stderrAvailable: activity.stderrAvailable ?? false,
          outputPreview: activity.outputPreview,
          exitCode: activity.exitCode,
          durationMs: activity.durationMs,
        }}
      />
    </details>
  );
}

function TimelineEntry({
  item,
  onInspectFileChange,
  position,
  setSize,
}: {
  item: TimelineItem;
  onInspectFileChange: (fileChangeId: string) => void;
  position?: number;
  setSize?: number;
}) {
  if (item.kind === "operator") {
    return (
      <article
        className="timeline-entry operator-entry"
        data-state={item.turn.status}
        aria-posinset={position}
        aria-setsize={setSize}
      >
        <div className="entry-meta">
          <span>OPERATOR</span>
          <time dateTime={item.turn.startedAt}>{formatTime(item.turn.startedAt)}</time>
        </div>
        <p className="message-copy">{item.turn.prompt}</p>
        <StatusPill value={item.turn.status} pulse={item.turn.status === "running"} />
      </article>
    );
  }
  if (item.kind === "assistant") {
    const streaming = !item.completed;
    return (
      <article
        className={`timeline-entry assistant-entry${streaming ? " is-streaming" : ""}`}
        aria-posinset={position}
        aria-setsize={setSize}
      >
        <div className="entry-meta">
          <span>ASSISTANT</span>
          <span className={streaming ? "stream-badge" : undefined}>
            {item.completed ? "AUTHORITATIVE" : "STREAMING"}
          </span>
        </div>
        {streaming && item.content === "" ? (
          <ThinkingOrb label="Generating" compact />
        ) : (
          <p className={`assistant-copy message-copy${streaming ? " has-caret" : ""}`}>
            {item.content || "Waiting for first token…"}
          </p>
        )}
      </article>
    );
  }
  if (item.kind === "activity") {
    return (
      <article
        className="timeline-entry machine-entry"
        aria-posinset={position}
        aria-setsize={setSize}
      >
        <ActivityBlock activity={item.activity} />
      </article>
    );
  }
  return (
    <article
      className="timeline-entry file-entry"
      aria-posinset={position}
      aria-setsize={setSize}
    >
      <div className="entry-meta">
        <span>FILE CHANGE</span>
        <StatusPill value={item.fileChange.status} pulse={item.fileChange.status === "running"} />
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
  const inspectorRef = useRef<HTMLElement | null>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingInspectorFocusRef = useRef<string | null>(null);
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
  const [timelineViewport, setTimelineViewport] = useState({
    scrollTop: 0,
    height: 620,
  });
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const compactLayout = useMediaQuery("(max-width: 860px)");
  const [fleet, setFleet] = useState(initialFleetState);
  const [catalog, setCatalog] = useState(initialCatalogState);
  const [native, setNative] = useState(initialNativeState);
  const [settingsUi, setSettingsUi] = useState(initialSettingsState);
  const [leaseUi, setLeaseUi] = useState(initialLeaseState);
  const [attachmentsUi, setAttachmentsUi] = useState(initialAttachmentState);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
  const deviceIdRef = useRef(deviceId());
  const catalogFiltersRef = useRef(defaultCatalogFilters());
  const pendingUploadsRef = useRef(
    new Map<string, { bytes: Uint8Array; chunkCount: number; name: string }>(),
  );

  const send = useCallback((socket: WebSocket, envelope: unknown) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
    }
  }, []);

  const requestCatalog = useCallback(
    (socket: WebSocket, cursor: string | null = null) => {
      const requestId = crypto.randomUUID();
      const append = cursor !== null;
      setCatalog((current) =>
        catalogRequestStarted(current, requestId, append, catalogFiltersRef.current),
      );
      send(
        socket,
        makeEnvelope("sessions.catalog.list", {
          requestId,
          deviceId: deviceIdRef.current,
          pageSize: 100,
          cursor,
          filters: catalogFiltersRef.current,
        }),
      );
    },
    [send],
  );

  const subscribe = (socket: WebSocket, sessionId: string) => {
    lastSeenSeqRef.current = readCursor(sessionId);
    outputSeqRef.current.clear();
    setAttachmentsUi(initialAttachmentState());
    setSettingsUi(initialSettingsState());
    setLeaseUi(initialLeaseState());
    setPendingAttachmentIds([]);
    send(socket, makeEnvelope("sessions.list", {}));
    send(socket, makeEnvelope("providers.refresh", {}));
    requestCatalog(socket, null);
    send(
      socket,
      makeEnvelope("session.subscribe", {
        sessionId,
        afterSeq: lastSeenSeqRef.current,
      }),
    );
    send(
      socket,
      makeEnvelope("session.settings.get", { sessionId }),
    );
    send(
      socket,
      makeEnvelope("attachments.list", {
        sessionId,
        deviceId: deviceIdRef.current,
      }),
    );
  };

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let bootstrapController: AbortController | undefined;

    const scheduleReconnect = () => {
      reconnectAttempt += 1;
      const delay = Math.min(5_000, 500 * 2 ** Math.min(reconnectAttempt - 1, 3));
      reconnectTimer = window.setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (disposed) return;
      setConnection(connectedBeforeRef.current ? "reconnecting" : "connecting");
      bootstrapController = new AbortController();
      let browserTicket: string;
      try {
        browserTicket = (
          await requestBrowserRuntimeConfig(
            CORE_HTTP_ORIGIN,
            bootstrapController.signal,
          )
        ).ticket;
      } catch {
        if (disposed) return;
        setConnection("offline");
        setArtifactAccessToken(null);
        setNotice(
          "Core runtime authentication unavailable. Draft retained; retrying safely.",
        );
        scheduleReconnect();
        return;
      }
      if (disposed) return;
      const socket = new WebSocket(
        CORE_URL,
        websocketCapability("browser", browserTicket),
      );
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
        setFleet((current) => reduceFleet(current, message));
        setCatalog((current) => reduceCatalog(current, message));
        setNative((current) => reduceNative(current, message));
        setSettingsUi((current) => reduceSettings(current, message));
        setLeaseUi((current) => reduceLease(current, message));
        setAttachmentsUi((current) =>
          reduceAttachments(current, message, selectedSessionRef.current),
        );
        if (message.type === "sessions.snapshot") setSessions(message.payload.sessions);
        if (message.type === "runtime.status") setRuntime(message.payload.runtime);
        if (message.type === "providers.snapshot") {
          const controllable = controllableProviders(message.payload.snapshot);
          setSelectedProviderId((current) => {
            if (current && controllable.some((item) => item.providerId === current)) {
              return current;
            }
            return controllable[0]?.providerId ?? null;
          });
        }
        if (message.type === "session.command.accepted") {
          setNotice(`Session command accepted · rev ${message.payload.revision}`);
          // Metadata mutations change pin/archive/title — refresh first catalog page.
          const liveSocket = socketRef.current;
          if (liveSocket?.readyState === WebSocket.OPEN) {
            requestCatalog(liveSocket, null);
          }
        }
        if (message.type === "session.provider.status") {
          setNotice(
            `Provider binding ${message.payload.status}${
              message.payload.failureCode ? ` · ${message.payload.failureCode}` : ""
            }`,
          );
        }
        if (message.type === "command.accepted") {
          setNotice(`Command accepted · ${message.payload.commandId}`);
        }
        if (message.type === "command.rejected") {
          setNotice(`${message.payload.error.code}: ${message.payload.error.message}`);
          const approvalId = approvalForRejectedCommand(
            approvalCommandsRef.current,
            message.payload.commandId,
          );
          if (approvalId !== null) {
            setResolving((current) => {
              const next = new Set(current);
              next.delete(approvalId);
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
        scheduleReconnect();
      });
      socket.addEventListener("error", () => socket.close());
    };

    void connect();
    return () => {
      disposed = true;
      bootstrapController?.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const timelineItems = useMemo(() => buildTimeline(snapshot), [snapshot]);
  const timelineVirtualized =
    timelineItems.length > TIMELINE_VIRTUALIZATION_THRESHOLD;
  const timelineWindow = useMemo(
    () =>
      virtualTimelineWindow(
        timelineItems.length,
        timelineViewport.scrollTop,
        timelineViewport.height,
      ),
    [timelineItems.length, timelineViewport.height, timelineViewport.scrollTop],
  );
  const renderedTimelineItems = timelineVirtualized
    ? timelineItems.slice(timelineWindow.start, timelineWindow.end)
    : timelineItems;
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
    const container = timelineRef.current;
    if (container === null) return;
    const update = () =>
      setTimelineViewport({
        scrollTop: container.scrollTop,
        height: container.clientHeight,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!compactLayout || !inspectorOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const targetId = pendingInspectorFocusRef.current;
      pendingInspectorFocusRef.current = null;
      const target = targetId === null
        ? inspectorRef.current
        : document.getElementById(targetId);
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compactLayout, inspectorOpen, selectedFileChangeId]);

  useEffect(() => {
    if (!compactLayout || !inspectorOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setInspectorOpen(false);
      inspectorTriggerRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [compactLayout, inspectorOpen]);

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
  const selectedProvider =
    fleet.snapshot?.providers.find((item) => item.providerId === selectedProviderId) ??
    null;

  useEffect(() => {
    if (!selectedProvider) {
      setSelectedAccountId(null);
      return;
    }
    const defaultAccount =
      selectedProvider.accounts.find((account) => account.isDefault)?.accountId ??
      selectedProvider.accounts[0]?.accountId ??
      null;
    setSelectedAccountId((current) => {
      if (current && selectedProvider.accounts.some((account) => account.accountId === current)) {
        return current;
      }
      return defaultAccount;
    });
  }, [selectedProvider]);

  useEffect(() => {
    const socket = socketRef.current;
    if (
      socket?.readyState !== WebSocket.OPEN ||
      !selectedProviderId ||
      !selectedAccountId
    ) {
      return;
    }
    const remote = capabilitySupported(selectedProvider, "list_sessions");
    if (!remote.ok) return;
    send(
      socket,
      makeEnvelope("sessions.native.refresh", {
        providerId: selectedProviderId,
        accountId: selectedAccountId,
      }),
    );
  }, [selectedProviderId, selectedAccountId, selectedProvider, send]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    const socket = socketRef.current;
    if (!availability.canSubmit || value === "" || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    const settingsRevision = settingsUi.snapshot?.revision;
    if (settingsRevision === undefined) {
      setNotice("Settings revision unavailable — wait for session.settings.snapshot");
      return;
    }
    const commandId = crypto.randomUUID();
    const readyIds = pendingAttachmentIds.filter((id) =>
      attachmentsUi.attachments.some(
        (item) => item.attachmentId === id && item.status === "ready",
      ),
    );
    send(
      socket,
      makeEnvelope("turn.submit", {
        commandId,
        sessionId: selectedSessionId,
        prompt: value,
        deviceId: deviceIdRef.current,
        settingsRevision,
        attachmentIds: readyIds.length > 0 ? readyIds : undefined,
      }),
    );
    sessionStorage.removeItem(draftKey(selectedSessionId));
    setPrompt("");
    setPendingAttachmentIds([]);
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
    trackApprovalCommand(
      approvalCommandsRef.current,
      key,
      approval.approvalId,
      commandId,
    );
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
    pendingInspectorFocusRef.current = "diff-review";
    if (compactLayout) setInspectorOpen(true);
    else {
      pendingInspectorFocusRef.current = null;
      document.querySelector<HTMLElement>("#diff-review")?.focus({ preventScroll: false });
    }
  };

  const openInspector = (focusId: string | null = null) => {
    pendingInspectorFocusRef.current = focusId;
    if (compactLayout) setInspectorOpen(true);
    else {
      pendingInspectorFocusRef.current = null;
      if (focusId !== null) {
        document.getElementById(focusId)?.focus({ preventScroll: false });
      }
    }
  };

  const closeInspector = () => {
    setInspectorOpen(false);
    window.requestAnimationFrame(() => inspectorTriggerRef.current?.focus());
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
    if (timelineVirtualized) {
      setTimelineViewport({
        scrollTop: container.scrollTop,
        height: container.clientHeight,
      });
    }
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
  const approvalCount = sessions.reduce(
    (total, item) => total + item.pendingApprovalCount,
    0,
  );
  const catalogEntry =
    catalog.sessions.find((item) => item.sessionId === selectedSessionId) ?? null;
  const sessionTitle = catalogEntry?.title ?? selectedSessionId;
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
  const createDisabledReason = (() => {
    if (connection !== "online") return "Core offline";
    if (!selectedProviderId || !selectedAccountId) return "Select provider and account";
    const remote = capabilitySupported(selectedProvider, "create_session");
    if (!remote.ok) return remote.reason;
    const account = selectedProvider?.accounts.find(
      (item) => item.accountId === selectedAccountId,
    );
    if (account?.control !== "remote_control") {
      return "Selected account is inventory-only";
    }
    return null;
  })();

  const textAttach = capabilitySupported(selectedProvider, "file_input");
  const imageAttach = capabilitySupported(selectedProvider, "image_input");
  const attachDisabledReason =
    !textAttach.ok && !imageAttach.ok
      ? textAttach.reason ?? imageAttach.reason
      : null;

  const uploadFiles = async (files: FileList) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const remaining =
      MAX_INPUT_ATTACHMENTS_PER_TURN -
      pendingAttachmentIds.length -
      attachmentsUi.attachments.filter((item) => item.status === "ready").length;
    const queue = Array.from(files).slice(0, Math.max(0, remaining));
    for (const file of queue) {
      const name = basenameOnly(file.name);
      if (!name) {
        setNotice("Attachment name must be a basename only");
        continue;
      }
      const mediaType = file.type || "text/plain";
      const kind = attachmentKindForMediaType(mediaType);
      if (kind === "image" && !imageAttach.ok) {
        setNotice(imageAttach.reason ?? "Image input unsupported");
        continue;
      }
      if (kind === "text" && !textAttach.ok) {
        setNotice(textAttach.reason ?? "File input unsupported");
        continue;
      }
      if (kind === "document" || kind === "archive") {
        setNotice("PDF/ZIP/document attachments are rejected by M9 policy");
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = await sha256Hex(bytes.buffer);
      const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / INPUT_ATTACHMENT_CHUNK_BYTES));
      const commandId = crypto.randomUUID();
      send(
        socket,
        makeEnvelope("attachment.upload.begin", {
          commandId,
          sessionId: selectedSessionId,
          deviceId: deviceIdRef.current,
          name,
          kind,
          mediaType: mediaType as
            | "text/plain"
            | "text/markdown"
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp",
          byteLength: bytes.byteLength,
          sha256: digest,
          chunkCount,
        }),
      );
      // Chunks are driven after attachment.command.accepted via notice flow —
      // store pending file bytes keyed by command for the accepted handler path.
      pendingUploadsRef.current.set(commandId, { bytes, chunkCount, name });
    }
  };

  useEffect(() => {
    // When an attachment becomes uploading with progress 0, stream chunks for matching pending upload by name+size
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const attachment of attachmentsUi.attachments) {
      if (attachment.status !== "uploading") continue;
      if (attachmentsUi.uploadProgress[attachment.attachmentId]) continue;
      const pending = [...pendingUploadsRef.current.entries()].find(
        ([, value]) =>
          value.name === attachment.name &&
          value.bytes.byteLength === attachment.byteLength,
      );
      if (!pending) continue;
      const [commandId, value] = pending;
      pendingUploadsRef.current.delete(commandId);
      void (async () => {
        for (let index = 0; index < value.chunkCount; index += 1) {
          const start = index * INPUT_ATTACHMENT_CHUNK_BYTES;
          const end = Math.min(value.bytes.byteLength, start + INPUT_ATTACHMENT_CHUNK_BYTES);
          const slice = value.bytes.subarray(start, end);
          let binary = "";
          for (const byte of slice) binary += String.fromCharCode(byte);
          const contentBase64 = btoa(binary);
          send(
            socket,
            makeEnvelope("attachment.upload.chunk", {
              sessionId: selectedSessionId,
              deviceId: deviceIdRef.current,
              attachmentId: attachment.attachmentId,
              chunkIndex: index,
              contentBase64,
            }),
          );
        }
        send(
          socket,
          makeEnvelope("attachment.upload.complete", {
            commandId: crypto.randomUUID(),
            sessionId: selectedSessionId,
            deviceId: deviceIdRef.current,
            attachmentId: attachment.attachmentId,
          }),
        );
        setPendingAttachmentIds((ids) =>
          ids.includes(attachment.attachmentId)
            ? ids
            : [...ids, attachment.attachmentId],
        );
      })();
    }
  }, [attachmentsUi.attachments, attachmentsUi.uploadProgress, selectedSessionId, send]);

  const operationalAnnouncement = `${connectionLabel(connection)}. Session ${selectedSessionId} is ${formatState(sessionState)}. ${pendingApprovals.length} pending ${pendingApprovals.length === 1 ? "approval" : "approvals"}.`;
  const systemThinking =
    connection === "connecting" ||
    connection === "syncing" ||
    connection === "reconnecting" ||
    timelineBusy;
  const thinkingLabel =
    connection === "connecting"
      ? "Connecting"
      : connection === "reconnecting"
        ? "Reconnecting"
        : connection === "syncing"
          ? "Syncing"
          : timelineBusy
            ? "Working"
            : "Idle";

  return (
    <div className={`app-shell${systemThinking ? " app-thinking" : ""}`}>
      <a className="skip-link" href="#session-console">Skip to Session Console</a>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {operationalAnnouncement}
      </p>
      <div className="ambient ambient-a" aria-hidden="true" />
      <div className="ambient ambient-b" aria-hidden="true" />

      <header className="command-bar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            <span className="brand-mark-core" />
            MC
          </span>
          <div className="brand-copy">
            <p className="eyebrow">AI-RC · FLIGHT OPS</p>
            <h1>Mission Control</h1>
          </div>
        </div>
        <div className="system-strip" aria-label="System connection status">
          {systemThinking && <ThinkingOrb label={thinkingLabel} compact />}
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
        <div className="overview-heading">
          <div>
            <p className="eyebrow">TELEMETRY · ALL SESSIONS</p>
            <h2 id="overview-title">Mission Overview</h2>
          </div>
          <button
            type="button"
            className="secondary-button mobile-panel-toggle"
            aria-expanded={overviewOpen}
            aria-controls="mission-metrics"
            onClick={() => setOverviewOpen((open) => !open)}
          >
            {overviewOpen ? "Hide overview" : "Show overview"}
          </button>
        </div>
        <dl
          className="mission-metrics"
          id="mission-metrics"
          hidden={compactLayout && !overviewOpen}
        >
          <div>
            <dt>Catalog</dt>
            <dd>{catalog.total.toString().padStart(2, "0")}</dd>
          </div>
          <div>
            <dt>Providers</dt>
            <dd>{(fleet.snapshot?.providers.length ?? 0).toString().padStart(2, "0")}</dd>
          </div>
          <div><dt>Active</dt><dd>{activeCount.toString().padStart(2, "0")}</dd></div>
          <div><dt>Approval</dt><dd>{approvalCount.toString().padStart(2, "0")}</dd></div>
        </dl>
      </section>

      <div className="m9-top-grid">
        <ProviderFleetPanel
          fleet={fleet}
          selectedProviderId={selectedProviderId}
          selectedAccountId={selectedAccountId}
          onRefresh={() => {
            const socket = socketRef.current;
            if (socket) send(socket, makeEnvelope("providers.refresh", {}));
          }}
          onSelectProvider={setSelectedProviderId}
          onSelectAccount={setSelectedAccountId}
        />
        <SessionCatalogPanel
          catalog={catalog}
          native={native}
          selectedSessionId={selectedSessionId}
          createDisabledReason={createDisabledReason}
          providerOptions={(fleet.snapshot?.providers ?? []).map((provider) => ({
            id: provider.providerId,
            label: provider.displayName,
          }))}
          onFiltersChange={(patch) => {
            catalogFiltersRef.current = {
              ...catalogFiltersRef.current,
              ...patch,
            };
            setCatalog((current) => ({
              ...current,
              filters: catalogFiltersRef.current,
            }));
            const socket = socketRef.current;
            if (socket) requestCatalog(socket, null);
          }}
          onLoadMore={() => {
            const socket = socketRef.current;
            if (socket && catalog.nextCursor) requestCatalog(socket, catalog.nextCursor);
          }}
          onCreate={() => setShowCreateForm((open) => !open)}
          onSelectSession={(sessionId) => switchSession(sessionId)}
          onRename={(session, title) => {
            const socket = socketRef.current;
            if (!socket) return;
            const next = title.trim();
            if (next === "" || next === session.title) return;
            send(
              socket,
              makeEnvelope("session.rename", {
                commandId: crypto.randomUUID(),
                sessionId: session.sessionId,
                deviceId: deviceIdRef.current,
                expectedRevision: session.revision,
                title: next,
              }),
            );
          }}
          onPin={(session) => {
            const socket = socketRef.current;
            if (!socket) return;
            send(
              socket,
              makeEnvelope("session.pin", {
                commandId: crypto.randomUUID(),
                sessionId: session.sessionId,
                deviceId: deviceIdRef.current,
                expectedRevision: session.revision,
                pinned: !session.pinned,
              }),
            );
          }}
          onArchive={(session) => {
            const socket = socketRef.current;
            if (!socket) return;
            send(
              socket,
              makeEnvelope("session.archive", {
                commandId: crypto.randomUUID(),
                sessionId: session.sessionId,
                deviceId: deviceIdRef.current,
                expectedRevision: session.revision,
                archived: !session.archived,
              }),
            );
          }}
          onResumeNative={(providerSessionId) => {
            const socket = socketRef.current;
            if (!socket || !selectedProviderId || !selectedAccountId) return;
            // Resume always creates a new AICL Session ID; Core rejects existing IDs.
            const suffix = providerSessionId
              .replace(/[^A-Za-z0-9._-]/g, "-")
              .slice(0, 48);
            const sessionId = `import-${suffix || crypto.randomUUID().slice(0, 8)}`.slice(
              0,
              100,
            );
            send(
              socket,
              makeEnvelope("session.resume", {
                commandId: crypto.randomUUID(),
                sessionId,
                deviceId: deviceIdRef.current,
                providerId: selectedProviderId,
                accountId: selectedAccountId,
                providerSessionId,
              }),
            );
            setNotice(`Resuming native Session into ${sessionId}`);
            switchSession(sessionId);
          }}
          onRefreshNative={() => {
            const socket = socketRef.current;
            if (!socket || !selectedProviderId || !selectedAccountId) return;
            send(
              socket,
              makeEnvelope("sessions.native.refresh", {
                providerId: selectedProviderId,
                accountId: selectedAccountId,
              }),
            );
          }}
        />
        {showCreateForm && (
          <CreateSessionForm
            fleet={fleet.snapshot}
            selectedProviderId={selectedProviderId}
            selectedAccountId={selectedAccountId}
            disabledReason={createDisabledReason}
            onSubmit={(input) => {
              const socket = socketRef.current;
              if (!socket || !selectedProviderId || !selectedAccountId) return;
              if (!SESSION_PATTERN.test(input.sessionId)) {
                setNotice("Invalid Session ID");
                return;
              }
              send(
                socket,
                makeEnvelope("session.create", {
                  commandId: crypto.randomUUID(),
                  sessionId: input.sessionId,
                  deviceId: deviceIdRef.current,
                  title: input.title,
                  providerId: selectedProviderId,
                  accountId: selectedAccountId,
                  projectPath: input.projectPath,
                  model: input.model,
                  reasoningLevel: input.reasoningLevel,
                }),
              );
              setShowCreateForm(false);
              switchSession(input.sessionId);
            }}
          />
        )}
      </div>

      <div className="workspace">
        <aside className="session-rail" aria-labelledby="sessions-title">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">COMPAT · M8 STRIP</p>
              <h2 id="sessions-title">Quick open</h2>
            </div>
            <span className="mono-meta">{String(sessions.length).padStart(2, "0")}</span>
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
                    <span className="provider-label">SESSION</span>
                    <StatusPill
                      value={session.state}
                      pulse={session.state === "running" || session.state === "awaiting_approval"}
                    />
                  </span>
                  <strong title={session.sessionId}>{session.sessionId}</strong>
                  <span className="session-path" title={session.cwd ?? undefined}>
                    {session.cwd ?? "Project path unavailable"}
                  </span>
                  <span className="session-strip-bottom">
                    <span>{session.turnCount} turns</span>
                    <span>{session.pendingApprovalCount} approvals</span>
                    <time dateTime={session.lastActivityAt}>{formatTime(session.lastActivityAt)}</time>
                  </span>
                </button>
              ))
            ) : (
              <p className="empty-state">Legacy M8 snapshot empty — use Catalog V2 above.</p>
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
            <div className="console-title-block">
              <p className="eyebrow">FLIGHT CONSOLE</p>
              <h2 title={`${sessionTitle} · ${selectedSessionId}`}>{sessionTitle}</h2>
              <p className="console-path" title={catalogEntry?.projectPath ?? currentSummary?.cwd ?? undefined}>
                <span className="mono-meta">{selectedSessionId}</span>
                {" · "}
                {catalogEntry?.projectName ??
                  catalogEntry?.projectPath ??
                  currentSummary?.cwd ??
                  "Project path unavailable"}
              </p>
            </div>
            <div className="console-state">
              <StatusPill
                value={sessionState}
                pulse={timelineBusy || sessionState === "awaiting_approval"}
              />
              <span className="mono-meta">
                RT G{runtime?.generation ?? "—"} · T+{formatElapsed(latest?.startedAt, now)}
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
              <button type="button" className="secondary-button" onClick={() => openInspector("diff-review")}>
                Inspect file changes
              </button>
            </section>
          )}

          <div className="mobile-toolbelt">
            <button
              ref={inspectorTriggerRef}
              type="button"
              className="secondary-button"
              aria-expanded={inspectorOpen}
              aria-controls="session-inspector"
              onClick={() => openInspector()}
            >
              Open system health and file review
            </button>
          </div>

          <section className="timeline-panel" aria-labelledby="timeline-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">DOWNLINK · NORMALIZED</p>
                <h3 id="timeline-title">Timeline</h3>
                <span className="sr-only" id="timeline-help">
                  Live event text is not announced automatically. Use Return to live after reviewing older events.
                </span>
              </div>
              <span className="mono-meta">
                SEQ {String(snapshot?.lastEventSeq ?? 0).padStart(4, "0")}
              </span>
            </div>
            <div
              className="timeline"
              ref={timelineRef}
              onScroll={onTimelineScroll}
              role="feed"
              aria-busy={timelineBusy}
              aria-label="Session event timeline"
              aria-describedby="timeline-help"
            >
              {snapshot === null ? (
                <div className="loading-state" role="status">
                  <ThinkingOrb label="Loading session" />
                  <p>Loading authoritative Session projection…</p>
                </div>
              ) : timelineItems.length > 0 ? (
                timelineVirtualized ? (
                  <div
                    className="timeline-virtual-space"
                    style={{ height: timelineWindow.totalHeight }}
                  >
                    {renderedTimelineItems.map((item, index) => {
                      const absoluteIndex = timelineWindow.start + index;
                      return (
                        <div
                          className="timeline-virtual-row"
                          key={item.id}
                          style={{
                            height: TIMELINE_VIRTUAL_ROW_HEIGHT,
                            transform: `translateY(${timelineWindow.offsetTop + index * TIMELINE_VIRTUAL_ROW_HEIGHT}px)`,
                          }}
                        >
                          <TimelineEntry
                            item={item}
                            onInspectFileChange={inspectFileChange}
                            position={absoluteIndex + 1}
                            setSize={timelineItems.length}
                          />
                        </div>
                      );
                    })}
                    <span className="sr-only">
                      Showing events {timelineWindow.start + 1} through {timelineWindow.end} of {timelineItems.length}.
                    </span>
                  </div>
                ) : timelineItems.map((item, index) => (
                  <TimelineEntry
                    key={item.id}
                    item={item}
                    onInspectFileChange={inspectFileChange}
                    position={index + 1}
                    setSize={timelineItems.length}
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

          <SessionControlsPanel
            settings={settingsUi}
            fleet={fleet.snapshot}
            lease={leaseUi.snapshot}
            runtimeId={runtime?.runtimeId ?? null}
            runtimeGeneration={runtime?.generation ?? null}
            now={now}
            onUpdateSettings={(nextSettings: SessionSettings) => {
              const socket = socketRef.current;
              const revision = settingsUi.snapshot?.revision;
              if (!socket || revision === undefined) return;
              send(
                socket,
                makeEnvelope("session.settings.update", {
                  commandId: crypto.randomUUID(),
                  sessionId: selectedSessionId,
                  deviceId: deviceIdRef.current,
                  expectedRevision: revision,
                  settings: nextSettings,
                }),
              );
            }}
            onCreateLease={(minutes) => {
              const socket = socketRef.current;
              const settings = settingsUi.snapshot;
              if (
                !socket ||
                !settings ||
                !runtime ||
                !settings.settings.accountId ||
                !settings.settings.projectPath
              ) {
                setNotice("Lease requires runtime, account, and project path");
                return;
              }
              send(
                socket,
                makeEnvelope("approval.lease.create", {
                  commandId: crypto.randomUUID(),
                  sessionId: selectedSessionId,
                  deviceId: deviceIdRef.current,
                  expectedSettingsRevision: settings.revision,
                  expectedLeaseRevision: leaseUi.snapshot?.revision ?? 0,
                  providerId: settings.settings.providerId,
                  accountId: settings.settings.accountId,
                  projectPath: settings.settings.projectPath,
                  runtimeId: runtime.runtimeId,
                  runtimeGeneration: runtime.generation,
                  durationMinutes: minutes,
                }),
              );
            }}
            onRevokeLease={() => {
              const socket = socketRef.current;
              const lease = leaseUi.snapshot?.leases.find((item) => item.state === "active");
              if (!socket || !lease) return;
              send(
                socket,
                makeEnvelope("approval.lease.revoke", {
                  commandId: crypto.randomUUID(),
                  sessionId: selectedSessionId,
                  deviceId: deviceIdRef.current,
                  leaseId: lease.leaseId,
                  expectedLeaseRevision: lease.revision,
                }),
              );
            }}
            onEmergencyStop={() => {
              const socket = socketRef.current;
              if (!socket) return;
              send(
                socket,
                makeEnvelope("approval.emergency_stop", {
                  commandId: crypto.randomUUID(),
                  sessionId: selectedSessionId,
                  deviceId: deviceIdRef.current,
                }),
              );
            }}
          />

          <form onSubmit={submit} className="composer">
            <div className="composer-heading">
              <label htmlFor="prompt">Uplink command</label>
              <span className="mono-meta">
                CTRL / CMD + ENTER · settings rev {settingsUi.snapshot?.revision ?? "—"}
              </span>
            </div>
            <AttachmentComposer
              attachments={attachmentsUi.attachments}
              uploadProgress={attachmentsUi.uploadProgress}
              error={attachmentsUi.error}
              canAttachText={textAttach.ok}
              canAttachImage={imageAttach.ok}
              disabledReason={attachDisabledReason}
              onPickFiles={(files) => void uploadFiles(files)}
              onDelete={(attachmentId) => {
                const socket = socketRef.current;
                if (!socket) return;
                send(
                  socket,
                  makeEnvelope("attachment.delete", {
                    commandId: crypto.randomUUID(),
                    sessionId: selectedSessionId,
                    deviceId: deviceIdRef.current,
                    attachmentId,
                  }),
                );
                setPendingAttachmentIds((ids) => ids.filter((id) => id !== attachmentId));
              }}
            />
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
                  Abort
                </button>
                <button
                  type="submit"
                  className={timelineBusy ? "btn-busy" : undefined}
                  disabled={
                    !availability.canSubmit ||
                    prompt.trim() === "" ||
                    settingsUi.snapshot === null
                  }
                >
                  {timelineBusy ? "Working…" : "Launch"}
                </button>
              </div>
            </div>
          </form>
        </main>

        <aside
          className={`inspector ${compactLayout && inspectorOpen ? "mobile-inspector-open" : ""}`}
          id="session-inspector"
          ref={inspectorRef}
          aria-label="Session inspector"
          tabIndex={-1}
          hidden={compactLayout && !inspectorOpen}
        >
          <div className="mobile-drawer-heading">
            <div>
              <p className="eyebrow">SESSION TOOLS</p>
              <h2>Health and file review</h2>
            </div>
            <button type="button" className="secondary-button" onClick={closeInspector}>
              Close
            </button>
          </div>
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
              <div>
                <dt>Runtime</dt>
                <dd className="truncate-id" title={runtime?.runtimeId ?? undefined}>
                  {runtime?.runtimeId ?? "Unavailable"}
                </dd>
              </div>
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
        <aside className="approval-dock" aria-labelledby="approval-dock-title">
          <p className="sr-only" role="alert">
            Approval required. {pendingApprovals.length} pending.
          </p>
          <div className="approval-dock-heading">
            <div>
              <p className="eyebrow">OPERATOR DECISION</p>
              <h2 id="approval-dock-title">Approval Dock</h2>
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
