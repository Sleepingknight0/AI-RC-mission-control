# Active Execution Plan

## Purpose and observable outcome

M0 (measurements), M1 (walking skeleton), M2 (real first-token vertical slice),
M3 (durability/reconnect), M4 (approval/activity/diff safety), M5
(functional, responsive, accessible mission-control frontend), and both M6
self-audits, M7.1 accepted-finding remediation, and the M7.2 final gate are
complete on the target Windows host. Prototype 0 is complete. M8 now turns that
baseline into a loopback-only Windows daily-use host; M8.1 through M8.4 are
complete and M8.5 private Tailscale deployment is the next single milestone.

## Scope

- M0.1 target-Windows toolchain verification — **done**
- M0.2 three real Codex app-server spikes — **done**
- M0.3 measurement document and compatibility notes — **done**
- M1.1–M1.3 walking skeleton — **done**
- M2.1–M2.3 real Codex vertical slice and fault semantics — **done**
- M3.1–M3.3 SQLite durability, idempotency, replay, and refresh — **done**
- M4.1–M4.3 normalized activity, approval CAS, interrupt, and artifacts — **done**
- M5.1 functional mission-control frontend — **done**
- M5.2 responsive, accessibility, and UX polish — **done**
- M6.1 correctness/recovery self-audit — **done**
- M6.2 security/boundary self-audit — **done**
- M7.1 accepted-finding remediation — **done**
- M7.2 clean-checkout final gate — **done**
- M8.1 same-origin production Web host — **done**
- M8.2 runtime browser authentication — **done**
- M8.3 persistent LocalAppData configuration — **done**
- M8.4 compiled lifecycle and Windows startup task — **done**
- M8.5 private Tailscale Serve deployment — **current**
- M8.6 backup/restore and clean-install gate — pending

## Non-goals

- Anything excluded by `docs/00-PROTOTYPE-0-SCOPE.md`
- Optional external visual/audit passes before Prototype 0 is complete
- Claude provider integration, multi-user, cloud control plane
- M9 project/profile/session product operations, PWA, installer, and updater
- Tailscale Funnel or any public Internet exposure

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
- Core owns authoritative SQLite projections and events under the configured
  LocalAppData data directory
- Connector owns a separate inbox/outbox journal under the same configured data
  directory, never the Core database file
- Browser reconnect uses durable sequence replay plus a current projection snapshot
- Core schema v4 projects tool activities, file changes, approvals, artifacts,
  cross-type display sequence, guarded transitions, and terminal work settlement
- Connector schema v2 batches ephemeral UTF-8 command output, journals
  large-diff chunks in FIFO order, and reports durable command receipts
- Browser and Connector endpoints require separate per-launch capabilities;
  browser upgrades also require an exact allowed Origin
- Connector canonicalizes project roots against an operator-owned allowlist and
  launches the provider with an explicit environment allowlist
- Core publishes a normalized durable Session catalog; Web never reads SQLite or
  provider-specific state
- Core serves `apps/web/dist` on the same HTTP origin as `/ws`, preserving
  protocol/artifact routes and falling back to the SPA only for HTML navigation
- Web derives its default `ws:`/`wss:` endpoint from `window.location`; the Vite
  development launcher supplies `VITE_CORE_WS_URL` as an explicit override
- Browser connections bootstrap through `POST /runtime-config`; Core binds each
  one-time ticket to the exact Origin and stores only a bounded ticket digest
- Core and Connector load strict config version 1 from LocalAppData; atomic
  creation, canonical workspace containment, separate database paths, and
  non-persistent environment overrides are covered by process-level tests
- Production bundles Core, Connector, Host, and Doctor as JavaScript without
  runtime TypeScript/Vite; the Host owns ordered startup, health gating,
  per-launch Connector capability, bounded redacted logs, and IPC shutdown
- Windows startup runs as the interactive limited operator and stays attached
  to the Host so Task Scheduler can apply its restart-on-failure policy
- Web exposes Mission Overview, selectable Session rail, normalized timeline,
  recovery truth, a non-modal approval dock, command activity, and verified
  unified/side-by-side artifact-backed diffs
- Compact layouts collapse Overview and expose Health/Diff in a keyboard-safe
  drawer; large timelines use bounded DOM windowing after 200 items
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
- [x] Verify 375/768/1024/1440 layouts, safe areas, touch targets, and overflow (M5.2)
- [x] Add keyboard focus, live-status, reduced-motion, forced-color, and 200% text behavior (M5.2)
- [x] Add linear 100,000-item projection and bounded timeline windowing (M5.2)
- [x] Re-run real Codex mobile approval UX with a declined side effect (M5.2)
- [x] Trace state, ordering, idempotency, restart, fencing, approval, and artifact invariants (M6.1)
- [x] Run targeted recovery suites and read-only journal/channel/crash-window probes (M6.1)
- [x] Record 12 evidence-backed findings without remediation (M6.1)
- [x] Trace browser, Connector, HTTP, filesystem, provider, and rendering boundaries (M6.2)
- [x] Run hostile-Origin, impersonation, allocation, rate, and redaction probes (M6.2)
- [x] Preserve 6 Standards and 6 Spec findings without reranking or remediation (M6.2)
- [x] Deduplicate all accepted findings into a source-traceable register (M7.1)
- [x] Repair trust, containment, resource, environment, and redaction boundaries (M7.1)
- [x] Repair FIFO, receipt/lease, timeout, approval, command, timeline, and DB invariants (M7.1)
- [x] Add regression coverage and pass the complete repository gate (M7.1)
- [x] Run frozen clean-checkout install, migrations, and complete checks (M7.2)
- [x] Run the opt-in real provider lifecycle and Playwright browser gate (M7.2)
- [x] Repair final-gate terminal activity and diff normalization gaps (M7.2)
- [x] Serve the production Web build from the Core origin (M8.1)
- [x] Replace production browser tokens with bounded runtime tickets (M8.2)
- [x] Add shared versioned LocalAppData configuration and process smoke (M8.3)
- [x] Add compiled production supervisor, lifecycle commands, logs, and startup task (M8.4)

## M7.1 completed verification

- `reviews/codex/M7.1-REMEDIATION-REGISTER.md` retains every M6.1/M6.2 source
  ID and maps 17 accepted themes to an implementation and regression proof.
- Critical trust boundaries were repaired before recovery/state fixes. Provider
  compatibility, no prompt replay, row-level approval CAS, and normalized Web
  remain intact.
- `pnpm check`, `pnpm migrate`, and `git diff --check` are the completion gate.
  M7.2 owns only clean-checkout and opt-in real-provider validation.

## Protocol or schema changes

`@aicl/protocol` still reports Prototype version 1 but intentionally tightens
the lockstep Core/Connector contract with bounded receipts/outcomes, optional
durable display sequence, safe artifact media types, decoded semantic limits,
and role-specific WebSocket capability helpers. Durable event envelopes carry
Session-local sequence; assistant/command deltas remain ephemeral. Generated
Codex types, raw events, and raw provider request IDs stay under the adapter
boundary. Core SQLite schema is v4 and Connector schema is v2; both migrations
remain idempotent.

## Tests and fault scenarios

- `.\scripts\Check-Toolchain.ps1` passed (Git 2.54.0, Node 24.16.0, Codex 0.146.0).
- Mock spike passed after harness fix.
- Three real spikes: first-delta 4.5–6.3 s; ~55 deltas/s avg; peak 1 s up to 154;
  mid-turn kill reconstructed as `interrupted` via `thread/read` + `thread/resume`.
- `pnpm check`: strict typecheck, 66 unit/integration tests, ESLint, a real
  Windows child-tree termination test, and Vite production build passed.
- Live compatibility probe: Codex 0.146.0, 275 schema files, canonical SHA-256
  `b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03`.
- Opt-in real Codex E2E passed in 66.70 s: first delta/final, active rejection,
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
- M5.2 Playwright matrix at 375×812, 768×1024, 1024×768, and 1440×1000
  reported zero page/body overflow and zero enabled controls below 44×44 px.
- Keyboard order begins with the skip link and reaches Overview, Session,
  Health/Diff drawer, activities, and composer; Escape closes the drawer and
  restores focus. Important operational state uses explicit live regions.
- Primary/secondary/muted/accent/status token pairs measured 5.59:1–18.31:1;
  reduced-motion resolved animation/transition to 0.01 ms and one iteration.
- At 200% root text size, mobile content and the real Approval Dock had zero
  horizontal overflow; both decisions remained fully visible. Decline left its
  requested target absent and the Turn completed with zero console errors.
- Web tests construct 100,000 timeline items in 46–69 ms on this host and prove
  the virtual window renders at most 18 rows for an 844 px viewport.
- Process cleanup verified no listeners on 5173/8787/8788 and no project Codex
  process remained.
- M6.1 targeted Core suites passed: durability/reconnect, approval races, and
  database contract (3 files, 11 tests). Targeted Connector suites passed:
  journal, Codex adapter, and output batching (3 files, 12 tests).
- A same-millisecond Connector journal probe reproduced non-FIFO replay; 49 of
  100 message-completed/Turn-completed pairs reversed causal order.
- A same-process Connector channel outage beyond the grace period reproduced an
  incorrect `turn.outcome_unknown` despite unchanged boot and Runtime identity.
- A Core crash-window model reproduced a committed running Turn with no dispatch
  receipt and no reconciliation event after reopen.
- M6.2 targeted security suites passed: Core artifact/approval (2 files, 6
  tests), protocol validation (1 file, 6 tests), and Connector command,
  transport, and Windows process tree (3 files, 5 tests).
- An untrusted browser Origin received the artifact bearer and committed a Turn;
  an unauthenticated forged Connector installed its Runtime and intercepted the
  submitted prompt.
- Schema/allocation probes accepted effectively unlimited artifact declarations,
  a 196,608-byte decoded chunk above the nominal 128 KiB unit, and a durable
  completed-message envelope larger than the 1 MiB transport ceiling.
- A 500-message browser burst received 500 replies without throttle or close.
  A provider error containing a bearer canary reached Web unchanged.
- The first M6.2 `pnpm check` hit one 5 s timeout in the Core-restart recovery
  case. Its immediate targeted rerun passed all 3 tests (affected case 208 ms),
  and the complete rerun passed all 47 tests without source changes.
- M7.1 security regressions cover exact Origin/capability separation, canonical
  root containment, aggregate artifact limits, bounded range reads, inert
  artifact responses, environment isolation, redaction, rate/violation budgets,
  and heartbeat termination.
- M7.1 recovery regressions cover exact FIFO journal replay, durable receipts,
  missing-receipt and startup-lease convergence, RPC timeout ambiguity, one
  active Turn per Runtime, passive approval expiry, durable command failure,
  cross-type display order, and database transition guards.
- M8.3 config tests cover atomic defaults, strict/secret-free schema parsing,
  unsupported versions, environment override non-persistence, exact origins,
  canonical roots, junction escape, loopback/absolute path validation, and
  port/database separation.
- A process-level M8.3 test starts Core and Connector concurrently against one
  temporary config, connects the mock Runtime, serves Web/runtime bootstrap,
  creates separate SQLite stores, scans the file for capabilities/credentials,
  and removes the temporary processes and files. Bracketed IPv6 loopback origin
  and WebSocket URLs are regression-tested. The complete gate passes 92
  automated tests; the real-provider test remains opt-in and skipped.

## Surprises and measurements

- Unquoted Windows `shell: true` spawn broke `Program Files\nodejs\node.exe`.
- Raw schema fingerprint differed because generated object-key order varied;
  recursive canonical JSON produces a stable fingerprint across generations.
- Kill recovery is terminal `interrupted` on this CLI (not silent loss-only).
- Steady agent-delta payload ~253–263 bytes; ephemeral batching is mandatory.
- Closing a provider while a final Turn notification was still in flight could
  strand Connector shutdown; close now rejects the active waiter before RPC stop.
- A 375 px layout that passed at default text size overflowed by 27 px at 200%;
  the header status strip and timeline metadata now wrap instead of being clipped.
- Millisecond timestamps plus random UUID tie-breaking do not preserve Connector
  outbox insertion order under burst writes.
- The audit showed that channel loss needs an explicit lease: same-identity
  receipt reconciliation now preserves verified ownership, while expiry or a
  missing receipt converges to `outcome_unknown` without prompt replay.
- Loopback binding does not stop browser cross-site WebSocket access; Origin and
  application identity must be enforced explicitly.
- Per-frame WebSocket limits work, but aggregate artifact allocation, semantic
  message ceilings, and per-connection rate limits are separate controls.

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
- Collapse Overview and move Health/Diff into a full-height compact drawer so
  Session state, timeline, approval, and composer stay ahead of secondary data.
- Do not make streaming output a live region. Announce operational state and
  approvals separately so screen-reader users can review output without flooding.
- Use a linear grouped timeline projection and fixed 184 px virtual rows after
  200 records. Individual large rows remain internally scrollable, bounding DOM
  size while preserving their full normalized content.
- Keep M6.1 review evidence separate from repair work. The 12 findings are queued
  for triage/remediation in M7.1 after the independent M6.2 boundary audit.
- Preserve Standards and Spec M6.2 findings as separate axes. M7.1 may deduplicate
  implementation work, but must keep traceability to every original finding.
- Use separate browser/Connector capabilities generated per `pnpm dev` launch;
  treat exact Origin as a second browser boundary, not authentication by itself.
- Canonicalize operator-owned project roots before provider launch and pass only
  an explicit child environment allowlist.
- Use durable Connector receipts plus a bounded Core ownership lease to resolve
  restart ambiguity conservatively; missing proof always means unknown, never replay.
- Assign one Core display sequence to every durable projected timeline record;
  Web ordering never falls back to independent type/timestamp groups.
- Keep Core and Connector on loopback while consolidating Web and browser
  WebSocket traffic onto the Core origin. Do not treat static hosting as runtime
  authentication; M8.2 owns bounded bootstrap tickets and replay/expiry tests.
- Issue browser tickets only from an exact-Origin, bodyless POST. Tickets expire
  after 30 seconds, are consumed once, never enter URLs/storage/logs, and do not
  replace the independent Connector capability.
- Keep operational configuration in one strict, versioned LocalAppData file
  shared by Core and Connector. Persist no credentials or launch capabilities;
  validate environment overrides without writing them back, resolve project
  junctions before launch, and keep both SQLite files physically separate.
- Bundle the production Node entry points and keep the Scheduled Task attached
  to a foreground Host supervisor. Stop Connector/provider before Core through
  IPC; persist no launch capability and fail closed on unverified backup/restore.

## Latest verified outcome

M0 through M7.2 complete. Reproduce the final gates with:

```powershell
.\scripts\Check-Toolchain.ps1
pnpm --filter @aicl/connector codex:compatibility
pnpm migrate
pnpm check
pnpm dev
$env:AICL_REAL_CODEX = '1'
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
```

M6.1 evidence is recorded in
`reviews/codex/M6.1-CORRECTNESS-RECOVERY-AUDIT.md`.
M6.2 evidence is recorded in
`reviews/codex/M6.2-SECURITY-BOUNDARY-AUDIT.md`.
M7.1 decisions and evidence are recorded in
`reviews/codex/M7.1-REMEDIATION-REGISTER.md`.
M7.2 clean-checkout and browser evidence is recorded in
`reviews/codex/M7.2-FINAL-GATE.md`.

M8.1 adds a same-origin production Web host. M8.2 adds bounded runtime browser
authentication. M8.3 adds strict secret-free LocalAppData configuration. M8.4
adds source-map-free compiled bundles, a Host supervisor, root lifecycle/doctor
commands, bounded redacted logs, and an interactive-user Scheduled Task.
`pnpm check` passes 96 tests plus strict typecheck, lint, Web/Node production
builds, Windows process-tree coverage, and an isolated compiled lifecycle smoke.
Backup/restore remain fail-closed until M8.6. The next milestone is M8.5 private
Tailscale Serve deployment and second-device validation.

Prototype 0 remains complete. Grok visual refinement, Claude independent audit,
and Codex integration of reproducible feedback remain optional P1–P3 work and
do not replace the active M8 operationalization sequence.
