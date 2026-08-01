import {
  appendAssistantDelta,
  beginTurn,
  completeAssistantMessage,
  createSession,
  finishTurn,
  toSnapshot,
  type BeginTurnResult,
  type SessionState,
} from "@aicl/domain";
import type { SessionSnapshot } from "@aicl/protocol";

export class InMemorySessionStore {
  readonly #sessions = new Map<string, SessionState>();

  snapshot(sessionId: string): SessionSnapshot {
    return toSnapshot(this.#get(sessionId));
  }

  beginTurn(
    sessionId: string,
    input: Parameters<typeof beginTurn>[1],
  ): BeginTurnResult {
    const result = beginTurn(this.#get(sessionId), input);
    if (result.ok) this.#sessions.set(sessionId, result.state);
    return result;
  }

  appendDelta(
    sessionId: string,
    input: Parameters<typeof appendAssistantDelta>[1],
  ): SessionState {
    const state = appendAssistantDelta(this.#get(sessionId), input);
    this.#sessions.set(sessionId, state);
    return state;
  }

  completeMessage(
    sessionId: string,
    input: Parameters<typeof completeAssistantMessage>[1],
  ): SessionState {
    const state = completeAssistantMessage(this.#get(sessionId), input);
    this.#sessions.set(sessionId, state);
    return state;
  }

  finishTurn(
    sessionId: string,
    input: Parameters<typeof finishTurn>[1],
  ): SessionState {
    const state = finishTurn(this.#get(sessionId), input);
    this.#sessions.set(sessionId, state);
    return state;
  }

  #get(sessionId: string): SessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created = createSession(sessionId);
    this.#sessions.set(sessionId, created);
    return created;
  }
}
