# Prototype 0 Acceptance Tests

Each milestone should automate as many checks as practical and record manual Windows checks separately.

## Environment

### P0-ENV-001 — Toolchain probe

- Git, Node 24+, and Codex are detected.
- Missing optional Grok or Claude does not block M0–M4.
- Tool versions are printed without exposing credentials.

### P0-ENV-002 — Generated schema

- The installed Codex binary generates schema successfully.
- A deterministic fingerprint is stored with the Codex version.
- Unsupported version/fingerprint fails closed with a clear error.

## Process boundaries

### P0-PROC-001 — Separate Core and Connector

- Core and Connector run as separate OS processes.
- Killing Connector does not terminate Core or the browser UI.
- Core reports Connector offline.

### P0-PROC-002 — No process reattach claim

- After Connector restart, the old Runtime becomes `lost`.
- A resume creates a new Runtime generation.
- No code path attempts to reuse old stdio handles.

## Protocol

### P0-PROTO-001 — Versioned envelope

- Invalid protocol version is rejected with `PROTOCOL_UNSUPPORTED`.
- Invalid payload is rejected before state mutation.

### P0-PROTO-002 — No raw provider events

- WebSocket frames match normalized schemas.
- A test fails if a raw provider method/event object reaches `apps/web`.

### P0-PROTO-003 — One active Turn

- First Turn is accepted.
- Second Turn while active returns `TURN_ALREADY_ACTIVE`.
- No `queued` Turn row is created.

## Streaming

### P0-STREAM-001 — Real first token

- A browser prompt reaches real Codex app-server.
- Incremental text appears before the final message.
- First-delta latency is logged.

### P0-STREAM-002 — Ephemeral delta handling

- Token deltas are coalesced.
- No database transaction occurs per token.
- `message.completed` stores authoritative full text.

### P0-STREAM-003 — Backpressure

- Bounded queues expose an explicit overload/reconnect signal.
- Memory does not grow without bound during a burst fixture.

## Database and idempotency

### P0-DB-001 — Core events without Connector source

- Multiple Core-origin events with null Connector source insert successfully.
- Duplicate Connector source event is rejected by a partial unique index.

### P0-DB-002 — Command deduplication

- Same `commandId` plus same payload returns the existing result.
- Same `commandId` plus different payload returns `IDEMPOTENCY_KEY_REUSE`.
- Provider dispatch happens once.

### P0-DB-003 — Sequence and revision separation

- Durable event append advances event sequence.
- Ephemeral frames do not advance resource revisions.
- Approval resolution is not rejected because unrelated stream activity occurred.

## Reconnect and recovery

### P0-REC-001 — Browser refresh during Turn

- Runtime continues.
- Browser reconnect sends `lastSeenSeq`.
- Durable events replay without duplication.
- Live frames continue after replay.
- No new Turn is created.

### P0-REC-002 — Connector killed mid-Turn

- Runtime becomes `lost`.
- Turn becomes terminal only if provider history proves it.
- Otherwise Turn becomes `outcome_unknown`.
- Original prompt is not auto-resubmitted.

### P0-REC-003 — Core restart while Connector survives

This may be completed in a later milestone, but the protocol must not make it impossible:

- Connector journal retains unacknowledged events.
- Core reconciliation does not duplicate acknowledged events.

## Approval

### P0-APR-001 — Approval compare-and-set

- Pending approval resolves once.
- Duplicate resolution fails safely.
- Wrong Runtime generation is rejected.
- Expired approval is rejected.
- Session event traffic does not make the approval stale.

### P0-APR-002 — Approval after reconnect

- UI fetches authoritative approval state after reconnect.
- Buttons remain disabled until the current revision/generation is known.

## Payload and diff

### P0-PAY-001 — Envelope limit

- Inline payload stays below WebSocket maximum.
- Oversized diff is represented as artifact metadata.
- Artifact byte length and SHA-256 are verified.

## Security

### P0-SEC-001 — Project allowlist

- Valid path inside an allowed root is accepted.
- traversal, symlink/junction escape, and system paths are rejected.

### P0-SEC-002 — No arbitrary shell endpoint

- Protocol contains no generic `shell.exec` exposed to the browser.
- Commands are provider-mediated and approval-scoped.

### P0-SEC-003 — Secrets and traces

- Config examples contain no credentials.
- Raw provider traces are disabled by default and retention is bounded.

## Daily-use lifecycle

### M8-LIFE-001 — Compiled production start and stop

- `pnpm build` emits Web/Core/Connector/Host JavaScript without source maps or
  runtime `.ts` imports.
- Production start fails before spawning children when another process already
  owns the configured Core or Connector port; readiness cannot be borrowed from
  an unrelated development service on the same endpoint.
- Host starts Core before Connector and reports ready only after reconciliation.
- `pnpm stop` closes Connector/provider before Core and leaves no owned PID or
  production-state file.

### M8-LIFE-002 — Operational boundary

- Production state/logs contain no Connector capability.
- JSON logs redact known secret forms, cap input lines, and retain at most five
  5 MiB generations per service.
- The startup task names the current interactive operator, limited privilege,
  and never LocalSystem.
- Backup/restore fail closed until the verified M8.6 gate exists.

### M8-REMOTE-001 — Private Serve boundary

- Core and Connector remain bound to `127.0.0.1`; no application port is opened
  directly to the LAN or tailnet.
- Deployment invokes `tailscale serve --bg --yes
  http://127.0.0.1:<core-port>` and never invokes Tailscale Funnel.
- Core persists only the exact `https://<device>.<tailnet>.ts.net` Origin; paths,
  wildcards, HTTP origins, and arbitrary domains are rejected.
- Doctor distinguishes application offline, Connector offline, Tailscale
  missing/offline, Serve not configured, exact-Origin mismatch, Codex
  incompatibility, and database failure.

### M8-REMOTE-002 — Second-device proof

- The probe runs on a different online tailnet device and refuses the AICL host.
- HTTPS production HTML, `/health`, bodyless `/runtime-config`, and authenticated
  WSS `/ws` all pass through the ts.net origin.
- The one-time browser ticket is kept in memory and omitted from evidence.
- M8.5 remains incomplete until this proof is recorded from a real second device.
- The operator deferred this proof on 2026-08-03. Deferral permits M8.6 to
  proceed but is not a pass and must not be cited as remote-device evidence.

## UX

### P0-UI-001 — Stable stream

- Streaming does not remount the entire timeline.
- Manual upward scroll is preserved.
- Approval Dock does not move the reading position.

### P0-UI-002 — Mobile operation

- At mobile width, prompt, timeline, stop, and approval are usable.
- system health and overview remain accessible through drawers.

### P0-UI-003 — State clarity

- idle, running, approval, lost, failed, interrupted, and `outcome_unknown` are distinguishable without relying only on color.
