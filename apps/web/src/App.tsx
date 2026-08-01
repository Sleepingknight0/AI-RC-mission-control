import {
  PROTOCOL_VERSION,
  ServerEnvelopeSchema,
  makeEnvelope,
  type Runtime,
  type ServerEnvelope,
  type SessionSnapshot,
} from "@aicl/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";

const SESSION_ID = "session-demo";
const CORE_URL = import.meta.env.VITE_CORE_WS_URL ?? "ws://127.0.0.1:8787/ws";
const CURSOR_KEY = `aicl:last-event-seq:${SESSION_ID}`;

function durableSeq(message: ServerEnvelope) {
  if (
    message.type === "turn.started" ||
    message.type === "assistant.message.completed" ||
    message.type === "turn.completed" ||
    message.type === "turn.interrupted" ||
    message.type === "turn.failed" ||
    message.type === "turn.outcome_unknown"
  ) {
    return message.payload.seq;
  }
  return null;
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

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
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
        const parsed = ServerEnvelopeSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) {
          setNotice("Core sent an invalid normalized envelope.");
          return;
        }
        const message = parsed.data;
        if (message.type === "runtime.status") setRuntime(message.payload.runtime);
        if (message.type === "command.accepted") {
          setNotice(`Accepted ${message.payload.commandId}`);
        }
        if (message.type === "command.rejected") {
          setNotice(`${message.payload.error.code}: ${message.payload.error.message}`);
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

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AICL / PROTOTYPE 0</p>
          <h1>Mission Control Walking Skeleton</h1>
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
    </main>
  );
}
