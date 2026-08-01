import type {
  AssistantMessage,
  SessionSnapshot,
  Turn,
} from "@aicl/protocol";

export interface SessionState {
  sessionId: string;
  revision: number;
  lastEventSeq: number;
  activeTurnId: string | null;
  providerSessionId: string | null;
  turns: Turn[];
  messages: AssistantMessage[];
}

export type BeginTurnResult =
  | { ok: true; state: SessionState; turn: Turn }
  | { ok: false; code: "TURN_ALREADY_ACTIVE" };

export function createSession(sessionId: string): SessionState {
  return {
    sessionId,
    revision: 0,
    lastEventSeq: 0,
    activeTurnId: null,
    providerSessionId: null,
    turns: [],
    messages: [],
  };
}

export function beginTurn(
  state: SessionState,
  input: {
    turnId: string;
    commandId: string;
    prompt: string;
    startedAt: string;
  },
): BeginTurnResult {
  if (state.activeTurnId !== null) {
    return { ok: false, code: "TURN_ALREADY_ACTIVE" };
  }

  const turn: Turn = {
    turnId: input.turnId,
    commandId: input.commandId,
    status: "running",
    prompt: input.prompt,
    startedAt: input.startedAt,
    completedAt: null,
    failureCode: null,
    providerTurnId: null,
  };

  return {
    ok: true,
    turn,
    state: {
      ...state,
      revision: state.revision + 1,
      lastEventSeq: state.lastEventSeq + 1,
      activeTurnId: turn.turnId,
      turns: [...state.turns, turn],
    },
  };
}

export function appendAssistantDelta(
  state: SessionState,
  input: { turnId: string; messageId: string; text: string },
): SessionState {
  const existing = state.messages.find(
    (message) => message.messageId === input.messageId,
  );
  const messages = existing
    ? state.messages.map((message) =>
        message.messageId === input.messageId
          ? { ...message, content: message.content + input.text }
          : message,
      )
    : [
        ...state.messages,
        {
          messageId: input.messageId,
          turnId: input.turnId,
          content: input.text,
          completed: false,
        },
      ];

  return { ...state, messages };
}

export function completeAssistantMessage(
  state: SessionState,
  input: { turnId: string; messageId: string; content: string },
): SessionState {
  const message: AssistantMessage = {
    messageId: input.messageId,
    turnId: input.turnId,
    content: input.content,
    completed: true,
  };
  const exists = state.messages.some(
    (candidate) => candidate.messageId === input.messageId,
  );

  return {
    ...state,
    lastEventSeq: state.lastEventSeq + 1,
    messages: exists
      ? state.messages.map((candidate) =>
          candidate.messageId === input.messageId ? message : candidate,
        )
      : [...state.messages, message],
  };
}

export function finishTurn(
  state: SessionState,
  input: {
    turnId: string;
    status: "interrupted" | "completed" | "failed" | "outcome_unknown";
    completedAt: string;
    failureCode?: string;
  },
): SessionState {
  if (state.activeTurnId !== input.turnId) {
    return state;
  }

  return {
    ...state,
    revision: state.revision + 1,
    lastEventSeq: state.lastEventSeq + 1,
    activeTurnId: null,
    turns: state.turns.map((turn) =>
      turn.turnId === input.turnId
        ? {
            ...turn,
            status: input.status,
            completedAt: input.completedAt,
            failureCode: input.failureCode ?? null,
          }
        : turn,
    ),
  };
}

export function bindProviderSession(
  state: SessionState,
  providerSessionId: string,
): SessionState {
  if (state.providerSessionId === providerSessionId) return state;
  return { ...state, providerSessionId, revision: state.revision + 1 };
}

export function bindProviderTurn(
  state: SessionState,
  turnId: string,
  providerTurnId: string,
): SessionState {
  return {
    ...state,
    turns: state.turns.map((turn) =>
      turn.turnId === turnId ? { ...turn, providerTurnId } : turn,
    ),
  };
}

export function toSnapshot(state: SessionState): SessionSnapshot {
  return {
    sessionId: state.sessionId,
    revision: state.revision,
    lastEventSeq: state.lastEventSeq,
    activeTurnId: state.activeTurnId,
    providerSessionId: state.providerSessionId,
    turns: state.turns,
    messages: state.messages,
    activities: [],
    fileChanges: [],
    approvals: [],
  };
}
