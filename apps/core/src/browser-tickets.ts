import { createHash, randomUUID } from "node:crypto";

import { websocketCapabilityToken, type BrowserRuntimeConfig } from "@aicl/protocol";

interface TicketRecord {
  origin: string;
  expiresAtMs: number;
}

export class BrowserTicketRegistry {
  readonly #records = new Map<string, TicketRecord>();

  constructor(
    readonly ttlMs: number,
    readonly limit: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Browser ticket TTL must be a positive safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Browser ticket limit must be a positive safe integer");
    }
  }

  issue(origin: string, now = Date.now()): BrowserRuntimeConfig | undefined {
    this.#removeExpired(now);
    if (this.#records.size >= this.limit) return undefined;
    const ticket = randomUUID();
    const expiresAtMs = now + this.ttlMs;
    this.#records.set(ticketDigest(ticket), { origin, expiresAtMs });
    return {
      webSocketPath: "/ws",
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(
    protocolHeader: string | undefined,
    origin: string,
    now = Date.now(),
  ): boolean {
    if (protocolHeader === undefined) return false;
    for (const protocol of protocolHeader.split(",").map((value) => value.trim())) {
      const ticket = websocketCapabilityToken(protocol, "browser");
      if (ticket === null) continue;
      const digest = ticketDigest(ticket);
      const record = this.#records.get(digest);
      if (record === undefined) continue;
      if (record.expiresAtMs <= now) {
        this.#records.delete(digest);
        continue;
      }
      if (record.origin !== origin) continue;
      this.#records.delete(digest);
      return true;
    }
    return false;
  }

  clear(): void {
    this.#records.clear();
  }

  #removeExpired(now: number): void {
    for (const [digest, record] of this.#records) {
      if (record.expiresAtMs <= now) this.#records.delete(digest);
    }
  }
}

function ticketDigest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}
