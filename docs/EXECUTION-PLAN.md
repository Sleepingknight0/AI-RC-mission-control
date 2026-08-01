# Active Execution Plan

## Purpose and observable outcome

M0 (measurements), M1 (walking skeleton), M2 (real first-token vertical slice),
M3 (durability/reconnect), M4 (approval/activity/diff safety), and M5.1
(functional mission-control frontend) are complete on the target Windows host.
Codex owns every remaining Prototype 0 phase. The next observable outcome is an
M5.2 responsive, accessibility, and UX verification pass.

## Scope

- M0.1 target-Windows toolchain verification — **done**
- M0.2 three real Codex app-server spikes — **done**
- M0.3 measurement document and compatibility notes — **done**
- M1.1–M1.3 walking skeleton — **done**
- M2.1–M2.3 real Codex vertical slice and fault semantics — **done**
- M3.1–M3.3 SQLite durability, idempotency, replay, and refresh — **done**
- M4.1–M4.3 normalized activity, approval CAS, interrupt, and artifacts — **done**
- M5.1 functional mission-control frontend — **done**
- Current: M5.2 responsive, accessibility, and UX polish (Codex-owned)
- Next after this run: M6.1 correctness/recovery self-audit

## Non-goals

- Anything excluded by `docs/00-PROTOTYPE-0-SCOPE.md`
- Optional external visual/audit passes before Prototype 0 is complete
- Claude provider integration, multi-user, cloud control plane

## Current repository state

- Starter docs, prompts, and spike harness present
- Git repository initialized locally (no remote required for M0)
- Windows spawn fix in `spikes/codex-app-server/spike.mjs`
- Real batch artifacts: `spikes/codex-app-server/artifacts/real-20260801-091022/`
- Measurements recorded in `docs/measurements/CODEX-SPIKE-RESULTS.md`
- Strict-TypeScript workspaces implemented under `apps/*` and `packages/*`
- Core and Connector run as separate Node processes with independent health endpoints
- Web consumes only `@aicl/protocol` normalized envelopes
- Real Codex adapter owns stdio transport, normalization, supervision, and resume
- Installed Codex 0.146.0 schema is pinned by a canonical compatibility gate
- Deterministic mock remains available with `AICL_PROVIDER=mock`
- Core owns authoritative SQLite projections and events under `.data/aicl-core.db`
- Connector owns a separate inbox/outbox journal under `.data/aicl-connector.db`
- Browser reconnect uses durable sequence replay plus a current projection snapshot
- Core schema v2 projects tool activities, file changes, approvals, and artifacts
- Connector batches ephemeral UTF-8 command output and journals large-diff chunks
- Core publishes a normalized durable Session catalog; Web never reads SQLite or
  provider-specific state
- Web exposes Mission Overview, selectable Session rail, normalized timeline,
  recovery truth, a non-modal approval dock, command activity, and verified
  unified/side-by-side artifact-backed diffs
- Grok and Claude launchers remain optional post-prototype tools only

## Implementation sequence

- [x] Inspect repository and target milestone
- [x] Run the repository toolchain check
- [x] Fix Windows `shell: true` path quoting in spike harness
- [x] Verify mock spike harness
- [x] Run three real Codex app-server spikes
- [x] Fill CODEX-SPIKE-RESULTS and mark M0 complete
- [x] Scaffold pnpm strict-TypeScript monorepo (M1.1)
- [x] Run Core and Connector as separate processes (M1.2)
- [x] Demonstrate mock normalized WebSocket flow (M1.3)
- [x] Add installed Codex schema compatibility gate (M2.1)
- [x] Demonstrate real browser-to-Codex first token (M2.2)
- [x] Test interrupt, active-Turn rejection, and provider-loss semantics (M2.3)
- [x] Add Core SQLite WAL and Connector journal (M3.1)
- [x] Add durable command idempotency and event replay (M3.2)
- [x] Test browser refresh during an active Turn (M3.3)
- [x] Normalize bounded command/tool output and file changes (M4.1)
- [x] Implement approval CAS, expiry, invalidation, and race tests (M4.2)
- [x] Implement authenticated artifact-backed large diffs (M4.3)
- [x] Build Mission Overview and a dense selectable Session rail from real snapshots (M5.1)
- [x] Recompose Session Console into stable timeline, activity, diff, recovery, approval, and composer surfaces (M5.1)
- [x] Add deterministic frontend state tests and verify the live browser flow (M5.1)

## M5.2 verification and rollback

- Verify keyboard order, visible focus, semantic labels, reduced motion, overflow,
  and touch targets; then run Web checks, `pnpm check`, and `git diff --check`.
- Exercise deterministic sessions at 375, 768, 1024, and 1440 px widths.
- Preserve the normalized protocol boundary; do not add provider-specific UI data.
- If the UI cannot derive a field from authoritative state, show `Unavailable` or
  omit it rather than invent telemetry. Revert only M5.1-owned frontend changes
  if the build or live command path regresses.

## Protocol or schema changes

`@aicl/protocol` version 1 now also includes normalized `sessions.list` and
`sessions.snapshot` messages. Each Session summary derives operational state,
latest Turn/runtime status, pending approvals, cwd, activity time, Turn count,
and durable cursor from Core projections. Durable event envelopes carry
Session-local sequence; assistant/command deltas remain ephemeral. Generated
Codex types, raw events, and raw provider request IDs stay under the adapter
boundary. No SQLite schema migration was required for M5.1.

## Tests and fault scenarios

- `.\scripts\Check-Toolchain.ps1` passed (Git 2.54.0, Node 24.16.0, Codex 0.146.0).
- Mock spike passed after harness fix.
- Three real spikes: first-delta 4.5–6.3 s; ~55 deltas/s avg; peak 1 s up to 154;
  mid-turn kill reconstructed as `interrupted` via `thread/read` + `thread/resume`.
- `pnpm check`: strict typecheck, 45 unit/integration tests, ESLint, a real
  Windows child-tree termination test, and Vite production build passed.
- Live compatibility probe: Codex 0.146.0, 275 schema files, canonical SHA-256
  `b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03`.
- Opt-in real Codex E2E passed in 73.64 s: first delta/final, active rejection,
  interrupt, provider death, `outcome_unknown`, new-process resume, no replay.
- Database tests cover schema v1 migration/idempotence, WAL/foreign keys/busy
  timeout, active-Turn and Connector-source partial uniqueness, and revisions
  independent from Session event sequence.
- Recovery tests cover duplicate command races, Core restart during an active
  Turn, Connector restart/runtime fencing, replay ordering/deduplication, and a
  deliberate failure between durable commit and live broadcast.
- Playwright reloaded the real React UI during a 600-line Codex stream. The
  active Turn restored at sequence 4, then the authoritative final reconstructed
  lines 001–600 at sequence 6 with 0 errors/0 warnings.
- Approval race tests cover two tabs, duplicate command replay, expiry, provider
  death, runtime-generation changes, and interrupt during command execution.
- Diff tests cover the 512 KiB inline threshold, sub-1 MiB WebSocket ceiling,
  SHA-256/length verification, authorization, byte range, and traversal denial.
- Playwright at 390×844 approved and declined real Codex command requests; only
  the approved command created its ignored proof artifact.
- Playwright exercised the M5.1 UI at 1440×1000 and 390×844: Session selection,
  Ctrl/Cmd+Enter submission, live output, reload-safe unsent drafts, and no
  automatic draft replay. Real Codex approval and decline paths produced zero
  browser console warnings or errors; the declined command created no file.
- Process cleanup verified no listeners on 5173/8787/8788 and no project Codex
  process remained.

## Surprises and measurements

- Unquoted Windows `shell: true` spawn broke `Program Files\nodejs\node.exe`.
- Raw schema fingerprint differed because generated object-key order varied;
  recursive canonical JSON produces a stable fingerprint across generations.
- Kill recovery is terminal `interrupted` on this CLI (not silent loss-only).
- Steady agent-delta payload ~253–263 bytes; ephemeral batching is mandatory.
- Closing a provider while a final Turn notification was still in flight could
  strand Connector shutdown; close now rejects the active waiter before RPC stop.

## Decision log

- Apply Windows spawn fix in the spike harness so M0 can complete on this host.
- Make `Invoke-Codex.ps1` select `codex.cmd` on Windows and judge native CLI
  completion by exit code because Windows PowerShell 5 wraps stderr as errors.
- Treat kill→`interrupted` as mappable terminal status; never auto-resubmit.
- Keep M1 persistence in memory; SQLite remains M3 scope.
- Keep provider-specific mock payloads inside the Connector adapter.
- Use measured rates for future batching defaults (see measurement doc table).
- Fail startup closed when Codex version or canonical schema fingerprint differs.
- Treat provider process/protocol loss as terminal `outcome_unknown`; never
  auto-resubmit an accepted command.
- Keep command idempotency in memory for M2; durable replay remains M3 scope.
- Use Node's built-in SQLite 3.53.0 with strict schema v1, WAL, foreign keys,
  `BEGIN IMMEDIATE`, and a single promise-serialized Core writer.
- Commit durable events before broadcast; do not transact per assistant delta.
- Persist Connector inbox/outbox before dispatch/send and acknowledge an outbox
  event only after Core commits it.
- Fence provider events by Connector/runtime generation. A Connector restart
  creates a new generation and unresolved work becomes `outcome_unknown`; never
  redispatch it automatically.
- Compare approval state with approval revision plus Turn/runtime/provider/expiry
  identity; Session revision is deliberately excluded from approval CAS.
- Keep a diff inline only when content is at most 512 KiB and its serialized
  envelope at most 768 KiB. Otherwise journal it in 128 KiB chunks and expose it
  only by opaque artifact ID with ephemeral bearer authorization.
- Represent pending approval on the Approval projection while Prototype 0 keeps
  the owning Turn in `running`; the one-active-Turn invariant stays unchanged.
- Publish the Session rail as a normalized Core read model instead of deriving
  fake metrics in Web. Omit provider model/profile/token data because the current
  authoritative projection does not expose it.
- Keep unsent prompts in per-Session browser storage and restore them only as
  drafts. Never submit or replay a draft during reconnect.
- Keep the mobile Approval Dock non-modal with a scrollable evidence region and
  an always-visible decision row so approval never blocks timeline inspection.

## Final outcome

M0 through M5.1 complete. Reproduce the normal and opt-in gates with:

```powershell
.\scripts\Check-Toolchain.ps1
pnpm --filter @aicl/connector codex:compatibility
pnpm migrate
pnpm check
pnpm dev
$env:AICL_REAL_CODEX = '1'
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
```

Next: Codex completes M5.2 and stops before the M6.1 self-audit.
