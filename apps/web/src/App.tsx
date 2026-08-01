import {
  PROTOCOL_VERSION,
  ServerEnvelopeSchema,
  makeEnvelope,
  type Approval,
  type FileChange,
  type Runtime,
  type ServerEnvelope,
  type SessionSnapshot,
  type ToolActivity,
} from "@aicl/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";

const requestedSessionId = new URLSearchParams(window.location.search).get("session");
const SESSION_ID =
  requestedSessionId !== null && /^[A-Za-z0-9._-]{1,100}$/.test(requestedSessionId)
    ? requestedSessionId
    : "session-demo";
const CORE_URL = import.meta.env.VITE_CORE_WS_URL ?? "ws://127.0.0.1:8787/ws";
const CORE_HTTP_ORIGIN = new URL(CORE_URL).origin.replace(/^ws/, "http");
const CURSOR_KEY = `aicl:last-event-seq:${SESSION_ID}`;
const DEVICE_KEY = "aicl:device-id";

function deviceId() {
  const existing = sessionStorage.getItem(DEVICE_KEY);
  if (existing !== null) return existing;
  const created = `web-${crypto.randomUUID()}`;
  sessionStorage.setItem(DEVICE_KEY, created);
  return created;
}

function durableSeq(message: ServerEnvelope) {
  switch (message.type) {
    case "turn.started":
    case "assistant.message.completed":
    case "turn.completed":
    case "turn.interrupted":
    case "turn.failed":
    case "turn.outcome_unknown":
    case "activity.started":
    case "activity.completed":
    case "file.change.started":
    case "file.change.completed":
    case "approval.requested":
    case "approval.resolved":
    case "approval.expired":
    case "approval.invalidated":
    case "interrupt.result":
      return message.payload.seq;
    default:
      return null;
  }
}

function upsertActivity(items: ToolActivity[], activity: ToolActivity) {
  return items.some((item) => item.activityId === activity.activityId)
    ? items.map((item) =>
        item.activityId === activity.activityId ? activity : item,
      )
    : [...items, activity];
}

function upsertFileChange(items: FileChange[], fileChange: FileChange) {
  return items.some((item) => item.fileChangeId === fileChange.fileChangeId)
    ? items.map((item) =>
        item.fileChangeId === fileChange.fileChangeId ? fileChange : item,
      )
    : [...items, fileChange];
}

function upsertApproval(items: Approval[], approval: Approval) {
  return items.some((item) => item.approvalId === approval.approvalId)
    ? items.map((item) =>
        item.approvalId === approval.approvalId ? approval : item,
      )
    : [...items, approval];
}

function updateSnapshot(
  current: SessionSnapshot | null,
  message: ServerEnvelope,
): SessionSnapshot | null {
  if (message.type === "session.snapshot") return message.payload.snapshot;
  if (current === null) return null;
  const seq = durableSeq(message);
  if (seq !== null && seq <= current.lastEventSeq) return current;

  switch (message.type) {
    case "turn.started":
      return {
        ...current,
        activeTurnId: message.payload.turn.turnId,
        lastEventSeq: message.payload.seq,
        turns: current.turns.some(
          (turn) => turn.turnId === message.payload.turn.turnId,
        )
          ? current.turns.map((turn) =>
              turn.turnId === message.payload.turn.turnId
                ? message.payload.turn
                : turn,
            )
          : [...current.turns, message.payload.turn],
      };
    case "assistant.message.delta": {
      const existing = current.messages.find(
        (candidate) => candidate.messageId === message.payload.messageId,
      );
      const messages = existing
        ? current.messages.map((candidate) =>
            candidate.messageId === message.payload.messageId
              ? { ...candidate, content: candidate.content + message.payload.text }
              : candidate,
          )
        : [
            ...current.messages,
            {
              messageId: message.payload.messageId,
              turnId: message.payload.turnId,
              content: message.payload.text,
              completed: false,
            },
          ];
      return { ...current, messages };
    }
    case "assistant.message.completed":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        messages: current.messages.some(
          (candidate) => candidate.messageId === message.payload.messageId,
        )
          ? current.messages.map((candidate) =>
              candidate.messageId === message.payload.messageId
                ? {
                    ...candidate,
                    content: message.payload.content,
                    completed: true,
                  }
                : candidate,
            )
          : [
              ...current.messages,
              {
                messageId: message.payload.messageId,
                turnId: message.payload.turnId,
                content: message.payload.content,
                completed: true,
              },
            ],
      };
    case "activity.started":
    case "activity.completed":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        activities: upsertActivity(current.activities, message.payload.activity),
      };
    case "command.output.batch":
      return {
        ...current,
        activities: current.activities.map((activity) =>
          activity.activityId === message.payload.activityId
            ? {
                ...activity,
                outputPreview: `${activity.outputPreview}${message.payload.output}`.slice(
                  -32 * 1024,
                ),
              }
            : activity,
        ),
      };
    case "file.change.started":
    case "file.change.completed":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        fileChanges: upsertFileChange(
          current.fileChanges,
          message.payload.fileChange,
        ),
      };
    case "approval.requested":
    case "approval.resolved":
    case "approval.expired":
    case "approval.invalidated":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        approvals: upsertApproval(current.approvals, message.payload.approval),
      };
    case "interrupt.result":
      return { ...current, lastEventSeq: message.payload.seq };
    case "turn.completed":
    case "turn.interrupted":
    case "turn.outcome_unknown":
      return {
        ...current,
        activeTurnId: null,
        lastEventSeq: message.payload.seq,
        turns: current.turns.map((turn) =>
          turn.turnId === message.payload.turnId
            ? {
                ...turn,
                status:
                  message.type === "turn.completed"
                    ? "completed"
                    : message.type === "turn.interrupted"
                      ? "interrupted"
                      : "outcome_unknown",
                completedAt: message.sentAt,
              }
            : turn,
        ),
      };
    case "turn.failed":
      return {
        ...current,
        activeTurnId: null,
        lastEventSeq: message.payload.seq,
        turns: current.turns.map((turn) =>
          turn.turnId === message.payload.turnId
            ? {
                ...turn,
                status: "failed",
                failureCode: message.payload.failureCode,
                completedAt: message.sentAt,
              }
            : turn,
        ),
      };
    default:
      return current;
  }
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

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const outputSeqRef = useRef(new Map<string, number>());
  const approvalCommandsRef = useRef(
    new Map<string, { approvalId: string; commandId: string }>(),
  );
  const lastSeenSeqRef = useRef(
    Number.parseInt(sessionStorage.getItem(CURSOR_KEY) ?? "0", 10) || 0,
  );
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">(
    "connecting",
  );
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [prompt, setPrompt] = useState("Verify the normalized event path.");
  const [notice, setNotice] = useState("Waiting for Core snapshot…");
  const [artifactAccessToken, setArtifactAccessToken] = useState<string | null>(
    null,
  );
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      const socket = new WebSocket(CORE_URL);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setConnection("online");
        socket.send(
          JSON.stringify(
            makeEnvelope("client.hello", {
              clientName: "aicl-web",
              supportedProtocolVersions: [PROTOCOL_VERSION],
            }),
          ),
        );
        socket.send(
          JSON.stringify(
            makeEnvelope("session.subscribe", {
              sessionId: SESSION_ID,
              afterSeq: lastSeenSeqRef.current,
            }),
          ),
        );
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const decoded: unknown = JSON.parse(event.data);
        const parsed = ServerEnvelopeSchema.safeParse(decoded);
        if (!parsed.success) {
          setNotice("Core sent an invalid normalized envelope.");
          return;
        }
        const message = parsed.data;
        if (message.type === "server.hello") {
          setArtifactAccessToken(message.payload.artifactAccessToken);
        }
        if (message.type === "runtime.status") setRuntime(message.payload.runtime);
        if (message.type === "command.accepted") {
          setNotice(`Accepted ${message.payload.commandId}`);
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
          outputSeqRef.current.set(
            message.payload.activityId,
            message.payload.streamSeq,
          );
        }
        if (message.type === "replay.boundary" && message.payload.phase === "end") {
          lastSeenSeqRef.current = Math.max(
            lastSeenSeqRef.current,
            message.payload.upperBoundSeq,
          );
          sessionStorage.setItem(CURSOR_KEY, String(lastSeenSeqRef.current));
          setNotice(`Snapshot synchronized at seq ${message.payload.upperBoundSeq}`);
        }
        const seq = durableSeq(message);
        if (seq !== null && seq > lastSeenSeqRef.current) {
          lastSeenSeqRef.current = seq;
          sessionStorage.setItem(CURSOR_KEY, String(seq));
        }
        setSnapshot((current) => updateSnapshot(current, message));
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setConnection("offline");
        setArtifactAccessToken(null);
        reconnectTimer = window.setTimeout(connect, 500);
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    const socket = socketRef.current;
    if (value === "" || socket?.readyState !== WebSocket.OPEN) return;
    const commandId = crypto.randomUUID();
    socket.send(
      JSON.stringify(
        makeEnvelope("turn.submit", {
          commandId,
          sessionId: SESSION_ID,
          prompt: value,
        }),
      ),
    );
    setNotice(`Submitted ${commandId}`);
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
          sessionId: SESSION_ID,
          turnId,
        }),
      ),
    );
    setNotice(`Interrupt requested for ${turnId}`);
  };

  const resolveApproval = (
    approval: Approval,
    decision: "approved_once" | "declined",
  ) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const key = `${approval.approvalId}:${decision}`;
    const existing = approvalCommandsRef.current.get(key);
    const commandId = existing?.commandId ?? crypto.randomUUID();
    approvalCommandsRef.current.set(key, {
      approvalId: approval.approvalId,
      commandId,
    });
    socket.send(
      JSON.stringify(
        makeEnvelope("approval.resolve", {
          commandId,
          sessionId: SESSION_ID,
          approvalId: approval.approvalId,
          expectedRevision: approval.revision,
          decision,
          deviceId: deviceId(),
        }),
      ),
    );
    setResolving((current) => new Set(current).add(approval.approvalId));
    setNotice(`${decision} requested for ${approval.approvalId}`);
  };

  const downloadArtifact = async (fileChange: FileChange) => {
    if (fileChange.diff?.kind !== "artifact" || artifactAccessToken === null) return;
    try {
      setNotice(`Downloading ${fileChange.diff.artifact.artifactId}…`);
      const response = await fetch(
        `${CORE_HTTP_ORIGIN}${fileChange.diff.artifact.downloadPath}`,
        { headers: { Authorization: `Bearer ${artifactAccessToken}` } },
      );
      if (!response.ok) throw new Error(`Artifact request failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      const digest = await sha256Hex(bytes);
      if (digest !== fileChange.diff.artifact.sha256) {
        throw new Error("Artifact integrity check failed");
      }
      const url = URL.createObjectURL(
        new Blob([bytes], { type: fileChange.diff.artifact.mediaType }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileChange.fileChangeId}.diff`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded and verified ${fileChange.fileChangeId}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Artifact download failed");
    }
  };

  const pendingApprovals =
    snapshot?.approvals.filter((approval) => approval.state === "pending") ?? [];

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AICL / PROTOTYPE 0</p>
          <h1>Mission Control</h1>
        </div>
        <span className={`status ${connection}`}>{connection}</span>
      </header>

      <section className="telemetry" aria-label="Runtime telemetry">
        <div><span>Session</span><strong>{SESSION_ID}</strong></div>
        <div><span>Runtime</span><strong>{runtime?.status ?? "unknown"}</strong></div>
        <div><span>Revision</span><strong>{snapshot?.revision ?? 0}</strong></div>
        <div><span>Event seq</span><strong>{snapshot?.lastEventSeq ?? 0}</strong></div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Normalized timeline</h2>
          <code>{notice}</code>
        </div>
        <div className="timeline" aria-live="polite">
          {snapshot?.messages.length ? (
            snapshot.messages.map((message) => (
              <article key={message.messageId}>
                <span>{message.completed ? "COMPLETE" : "STREAMING"}</span>
                <p>{message.content}</p>
              </article>
            ))
          ) : (
            <p className="empty">No assistant output yet.</p>
          )}
        </div>
      </section>

      <section className="panel work-panel">
        <div className="panel-heading">
          <h2>Tool activity</h2>
          <code>{snapshot?.activities.length ?? 0} activities</code>
        </div>
        <div className="activity-list">
          {snapshot?.activities.length ? (
            snapshot.activities.map((activity) => (
              <details key={activity.activityId} open={activity.status === "running"}>
                <summary>
                  <span>{activity.title}</span>
                  <b className={`activity-state ${activity.status}`}>
                    {activity.status}
                  </b>
                </summary>
                <dl>
                  <div><dt>Working directory</dt><dd>{activity.cwd ?? "—"}</dd></div>
                  <div><dt>Exit code</dt><dd>{activity.exitCode ?? "—"}</dd></div>
                  <div><dt>Duration</dt><dd>{activity.durationMs == null ? "—" : `${activity.durationMs} ms`}</dd></div>
                </dl>
                <pre>{activity.outputPreview || "No output captured."}</pre>
              </details>
            ))
          ) : (
            <p className="empty">No tool activity yet.</p>
          )}
        </div>
      </section>

      <section className="panel work-panel">
        <div className="panel-heading">
          <h2>File changes</h2>
          <div className="segmented" aria-label="Diff display mode">
            <button
              className={diffMode === "unified" ? "selected" : ""}
              type="button"
              onClick={() => setDiffMode("unified")}
            >
              Unified
            </button>
            <button
              className={diffMode === "split" ? "selected" : ""}
              type="button"
              onClick={() => setDiffMode("split")}
            >
              Side by side
            </button>
          </div>
        </div>
        <div className="diff-list">
          {snapshot?.fileChanges.length ? (
            snapshot.fileChanges.map((fileChange) => (
              <article key={fileChange.fileChangeId} className="diff-card">
                <div className="diff-summary">
                  <div>
                    <strong>{fileChange.files.map((file) => file.path).join(", ")}</strong>
                    <small>{fileChange.status}</small>
                  </div>
                  <span><b>+{fileChange.additions}</b> / -{fileChange.deletions}</span>
                </div>
                {fileChange.diff?.kind === "inline" ? (
                  diffMode === "unified" ? (
                    <pre className="diff-content">{fileChange.diff.content}</pre>
                  ) : (
                    <div className="split-diff">
                      <pre>{splitDiff(fileChange.diff.content).before}</pre>
                      <pre>{splitDiff(fileChange.diff.content).after}</pre>
                    </div>
                  )
                ) : fileChange.diff?.kind === "artifact" ? (
                  <div className="artifact-callout">
                    <p>
                      Large diff · {fileChange.diff.artifact.byteLength.toLocaleString()} bytes
                    </p>
                    <button
                      type="button"
                      disabled={artifactAccessToken === null}
                      onClick={() => void downloadArtifact(fileChange)}
                    >
                      Download verified diff
                    </button>
                  </div>
                ) : (
                  <p className="empty">Diff metadata is not available.</p>
                )}
              </article>
            ))
          ) : (
            <p className="empty">No file changes yet.</p>
          )}
        </div>
      </section>

      <form onSubmit={submit} className="composer">
        <label htmlFor="prompt">Prompt</label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
        />
        <div>
          <small>
            Submit again while streaming to observe <code>TURN_ALREADY_ACTIVE</code>.
          </small>
          <div className="actions">
            <button
              className="secondary"
              type="button"
              disabled={snapshot?.activeTurnId == null}
              onClick={interrupt}
            >
              Interrupt
            </button>
            <button type="submit">Dispatch command</button>
          </div>
        </div>
      </form>

      {pendingApprovals.length > 0 && (
        <aside className="approval-dock" aria-label="Pending approvals">
          {pendingApprovals.map((approval) => (
            <article key={approval.approvalId}>
              <div>
                <p className="eyebrow">APPROVAL REQUIRED</p>
                <h2>{approval.payload.summary}</h2>
                {approval.payload.command && <code>{approval.payload.command}</code>}
                <small>
                  Expires {new Date(approval.expiresAt).toLocaleTimeString()}
                </small>
              </div>
              <div className="actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={resolving.has(approval.approvalId)}
                  onClick={() => resolveApproval(approval, "declined")}
                >
                  Decline
                </button>
                <button
                  type="button"
                  disabled={resolving.has(approval.approvalId)}
                  onClick={() => resolveApproval(approval, "approved_once")}
                >
                  Approve once
                </button>
              </div>
            </article>
          ))}
        </aside>
      )}
    </main>
  );
}
