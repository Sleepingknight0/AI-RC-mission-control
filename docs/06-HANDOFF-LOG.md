# AI and Operator Handoff Log

Append entries; do not rewrite prior entries unless correcting a factual error.

---

## Template

### YYYY-MM-DD HH:mm — Agent / Operator — Milestone

**Scope**

Describe exactly what was attempted.

**Files changed or reviewed**

- `path/to/file`

**Commands and tests**

```text
command
result
```

**Observable result**

State how to reproduce the behavior.

**Protocol/schema assumptions**

List any provider or protocol assumptions and their evidence.

**Known limitations or uncertain outcomes**

- item

**Requested next action**

One concrete next task.

---

### 2026-08-01 09:15 — Grok Build (operator-driven) — M0.1–M0.3

**Scope**

Start Prototype 0 on the freshly unpacked starter. Complete toolchain verification, three real Codex app-server empirical spikes, and write measurement/compatibility notes. Fix Windows spawn harness so mock and real spikes can run.

**Files changed or reviewed**

- `spikes/codex-app-server/spike.mjs` — Windows-safe process spawn (quote shell command lines; shell:false for `.exe`)
- `docs/measurements/CODEX-SPIKE-RESULTS.md` — filled from real run artifacts
- `docs/05-IMPLEMENTATION-STATUS.md` — M0.1–M0.3 checked
- `docs/06-HANDOFF-LOG.md` — this entry
- `docs/EXECUTION-PLAN.md` — M0 complete / M1 next
- Reviewed: `START-HERE.md`, `AGENTS.md`, spike README, three `REPORT.md` + `report.json` under `real-20260801-091022`

**Commands and tests**

```text
.\scripts\Check-Toolchain.ps1
→ required OK: git 2.54.0, node v24.16.0, codex-cli 0.146.0; optional pnpm/grok/claude/code present

pnpm run spike:mock
→ initially failed: 'C:\Program' not recognized (shell:true unquoted path)
→ after spike.mjs fix: exit 0, 80 mock deltas, recovery status inProgress

.\scripts\Run-CodexSpike.ps1 -Runs 3
→ batch real-20260801-091022; runs 1–3 exit 0
→ first-delta ~4.5–6.3 s; ~53–56 avg delta/s; peak 1s up to 154; kill→interrupted via read/resume
```

**Observable result**

```powershell
cd C:\Users\BlueWhaleX\Downloads\aicl-mission-control-prototype-starter-v1
.\scripts\Check-Toolchain.ps1
pnpm run spike:mock
Get-Content .\docs\measurements\CODEX-SPIKE-RESULTS.md
Get-Content .\spikes\codex-app-server\artifacts\real-20260801-091022\run-01\REPORT.md
```

**Protocol/schema assumptions**

- Installed methods include `initialize`, `thread/start`, `turn/start`, `item/agentMessage/delta`, `turn/completed`, `thread/read`, `thread/resume` (schema string scan + live traffic).
- Default model observed: `gpt-5.6-sol`.
- Mid-process kill reconstructs turn status `interrupted` (terminal) on this version — product may map that explicitly, still must not auto-resubmit.
- Schema SHA-256 fingerprints differed across three generation runs with same file count/size; do not hard-pin a single hash until variance is understood.

**Known limitations or uncertain outcomes**

- Schema fingerprint non-determinism across runs.
- Grok executed M0 as operator/implementer for harness + measurements; product architecture ownership remains Codex per `AGENTS.md`.
- Artifacts stay local/gitignored; only scrubbed metrics are in-repo.

**Requested next action**

Execute **M1.1–M1.3** walking skeleton via `prompts/codex/02-SCAFFOLD-WALKING-SKELETON.md` (Codex primary owner): pnpm monorepo, separate Core/Connector processes, mock normalized WebSocket flow.

---

### 2026-08-01 10:00 — Codex — M1.1–M1.3

**Scope**

Build the strict-TypeScript walking skeleton: versioned normalized protocol,
pure Session/Turn domain state, separate Core and Connector processes,
diagnostic React Web client, deterministic mock streaming, and refresh snapshot.

**Files changed or reviewed**

- `packages/protocol/src/index.ts` — strict Zod schemas for all M1 envelope families
- `packages/domain/src/index.ts` — pure active-Turn guard and snapshot transitions
- `apps/core/src/` — HTTP health endpoint, browser/Connector WebSocket boundaries, in-memory store
- `apps/connector/src/` — separate client process and raw mock-provider adapter
- `apps/web/src/` — normalized-protocol-only diagnostic console
- `apps/*/test`, `packages/*/test` — validation, guard, adapter, and end-to-end WebSocket tests
- `scripts/Invoke-Codex.ps1` — Windows native stderr compatibility

**Commands and tests**

```text
pnpm install
→ 7 workspace projects installed; lockfile updated

pnpm check
→ exit 0; strict typecheck, 6 tests, ESLint, Vite production build

pnpm dev
→ Web 5173 HTTP 200
→ Core 8787 {component:"core", status:"ready", connectorConnected:true}
→ Connector 8788 {component:"connector", status:"ready"}

git diff --check
→ exit 0
```

**Observable result**

Run `pnpm dev`, open `http://127.0.0.1:5173`, and dispatch the default prompt.
The timeline streams normalized mock deltas. Dispatch again while streaming to
observe `TURN_ALREADY_ACTIVE`; refresh to restore the completed snapshot.

**Protocol/schema assumptions**

- Protocol version 1 is the only accepted WebSocket version in M1.
- Core allocates durable sequence numbers; stream sequence remains ephemeral.
- Raw mock fields (`providerMethod`, `providerPayload`) terminate in the Connector adapter.
- M1 state is intentionally in memory; no SQLite durability claim is made.

**Known limitations or uncertain outcomes**

- Nested `codex exec` was clamped to read-only by the host, so the active Codex turn implemented Prompt 02 directly.
- `pnpm install` reported that the optional esbuild install script was ignored; Vitest and Vite build nevertheless passed.
- Real Codex App Server integration, interrupt, provider loss, and durable replay remain M2/M3 work.

**Requested next action**

Execute `prompts/codex/03-FIRST-TOKEN-VERTICAL-SLICE.md` for M2.1–M2.3, beginning with schema compatibility validation.

---

### 2026-08-01 14:10 — Codex — M2.1–M2.3

**Scope**

Replace the mock-only provider path with a supervised real Codex App Server
adapter. Add installed-schema compatibility, normalized streaming/terminal
events, interrupt, active-Turn rejection, provider-loss semantics, resume in a
new process, and an opt-in real fault-path test.

**Files changed or reviewed**

- `apps/connector/src/codex/` — generated schemas, compatibility gate, bounded
  line framer, correlated JSON-RPC transport, process supervision, and adapter
- `apps/connector/src/provider.ts` — provider boundary and explicit loss error
- `packages/protocol`, `packages/domain` — normalized identity, interrupt,
  `interrupted`, `lost`, `incompatible`, and `outcome_unknown`
- `apps/core/src/` — provider bindings, idempotency ledger, interrupt dispatch,
  provider-loss classification, and runtime status replay to new browsers
- `apps/web/src/` — interrupt control and terminal rendering
- Connector/Core tests — real-shaped fake provider, Windows child-tree kill,
  command idempotency, refresh, loss, and opt-in real Codex E2E

**Commands and tests**

```text
pnpm --filter @aicl/connector codex:compatibility
→ compatible=true; codex-cli 0.146.0; 275 files; canonical SHA b767c116...df03

pnpm check
→ exit 0; strict typecheck; 19 tests; ESLint; Windows process-tree test;
  Web production build; opt-in real test skipped by default

$env:AICL_REAL_CODEX='1'; pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
→ 1 passed in 71.39 s

Playwright against pnpm dev with AICL_PROVIDER=codex
→ React rendered 80 real streamed lines; refreshed snapshot complete;
  browser console 0 errors / 0 warnings
```

**Observable result**

Run `pnpm dev`, open `http://127.0.0.1:5173`, dispatch a prompt, and observe real
Codex deltas/final output. Interrupt is available while running. A second active
Turn is rejected, and killing the provider marks the accepted Turn
`outcome_unknown`; the next command resumes the same provider thread in a new
process without replaying the lost command.

**Protocol/schema assumptions**

- `codex-cli 0.146.0` plus canonical schema SHA `b767c116...df03` is the only
  accepted compatibility pair.
- Required methods: initialize, thread start/read/resume, turn start/interrupt,
  agent-message delta/item completion, and turn completion.
- Correct Codex sandbox wire value is `read-only`; provider IDs stay within
  normalized binding fields, while raw Codex events never reach Web.
- Process/protocol death after acceptance means `outcome_unknown`; no auto-replay.

**Known limitations or uncertain outcomes**

- Core state and the command ledger are still in memory; crash-safe idempotency
  and replay are deliberately M3 work.
- The original M0 spike request used invalid `readOnly` and fell back to cwd-only;
  its resume metadata reported `dangerFullAccess`. M2 product traffic uses the
  valid `read-only` value and must not reinterpret the old spike as sandbox proof.
- The real fault-path test consumes Codex time/quota, so it is opt-in.

**Requested next action**

Execute `prompts/codex/04-DURABILITY-AND-RECONNECT.md` for M3.1–M3.3. Do not
advance to M4 until SQLite WAL, Connector journal, durable idempotency/replay,
and active-Turn browser refresh are verified.

---

### 2026-08-01 23:31 — Codex — M3.1–M3.3

**Scope**

Replace the in-memory Core ledger with authoritative SQLite projections/events,
add a separate Connector SQLite inbox/outbox journal, implement durable command
idempotency and gap-free browser replay, and verify Core/Connector/browser
recovery without replaying an uncertain provider command.

**Files changed or reviewed**

- `apps/core/migrations/001_initial.sql`, `apps/core/src/migrate.ts`,
  `apps/core/src/store.ts` — schema v1, migrations, WAL configuration, serialized
  transactions, projections, durable events, and Connector-source deduplication
- `apps/core/src/server.ts` — commit-before-broadcast, replay barrier, runtime
  generation fencing, channel-loss grace, and reconnect behavior
- `apps/connector/migrations/001_initial.sql`, `apps/connector/src/journal.ts`,
  `apps/connector/src/client.ts` — durable inbox/outbox, identities, generations,
  acknowledgements, and unacknowledged-event replay
- `packages/protocol/src/index.ts`, `apps/web/src/App.tsx` — source metadata,
  replay boundaries, durable cursor tracking, reconnect, and projection dedupe
- Core/Connector database, journal, durability, reconnect, and regression tests

**Commands and tests**

```text
pnpm migrate
→ Core .data/aicl-core.db schemaVersion=1
→ Connector .data/aicl-connector.db schemaVersion=1; repeated run exit 0

pnpm check
→ exit 0; strict typecheck; 26 tests; ESLint; Web production build

pnpm --filter @aicl/connector codex:compatibility
→ compatible=true; Codex 0.146.0; canonical SHA b767c116...df03

$env:AICL_REAL_CODEX='1'; pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
→ 1 passed in 70.33 s

git diff --check
→ exit 0
```

**Observable result**

With real Codex, dispatch a prompt that emits 600 numbered lines and reload the
browser while the Turn is active. The refreshed tab restores the same running
Turn at durable sequence 4, resumes live delivery without a second provider
dispatch, then reconstructs the complete authoritative message (001–600) at
sequence 6. Browser console: 0 errors, 0 warnings.

Automated recovery additionally restarts Core while Connector/provider remain
alive, reconnects two tabs using the same `commandId`, injects a failure after a
durable commit but before broadcast, and restarts Connector. Missing committed
events replay once; a new Connector runtime generation fences stale events and
the unresolved old Turn becomes `outcome_unknown` without redispatch.

**Protocol/schema assumptions**

- Node 24.16.0 supplies SQLite 3.53.0; schema v1 requires SQLite strict tables
  and JSON validation support.
- Session `last_event_seq` advances only for durable visible events; resource
  revisions are independent. Assistant deltas are ephemeral.
- Connector source identity is `(connectorId, sourceEventId)` and is protected by
  a partial unique index only when both values are present.
- Same command ID plus same payload returns the stored result; changed payload is
  rejected. One running Turn per Session is enforced by a partial unique index.

**Known limitations or uncertain outcomes**

- SQLite access uses synchronous `DatabaseSync` behind a promise-serialized
  writer, suitable for this local prototype but not yet load/backpressure tested.
- Browser cursors live in `sessionStorage`; server-side cursor retention/garbage
  collection and bounded stream checkpoints are not implemented.
- Partial assistant text can disappear during a disconnect by design; only the
  completed assistant message is authoritative and durable.

**Requested next action**

Execute `prompts/codex/05-APPROVAL-INTERRUPT-AND-DIFF.md` for M4.1–M4.3. Do not
start Grok M5 until normalized command/file changes, approval CAS, and artifact-
backed large diffs pass their race and fault-path tests.

---

### 2026-08-02 01:20 — Codex — M4.1–M4.3

**Scope**

Normalize verified command/tool/file-change events, coalesce bounded ephemeral
output, implement approval CAS and interrupt results, persist artifact-backed
large diffs, and expose the minimal typed Web surfaces required before Grok M5.

**Files changed or reviewed**

- `apps/connector/src/` — installed-schema adapter mapping, output batcher,
  opaque approval correlation, artifact chunking, and deterministic shutdown
- `apps/core/src/`, `apps/core/migrations/002_approval_activity_artifacts.sql`
  — schema v2 projections, approval CAS/invalidation, artifact assembly/HTTP
- `apps/web/src/` — activity panel, sticky approval dock, diff modes, authenticated
  artifact download with SHA-256 verification, and selectable demo Session IDs
- `packages/protocol`, `packages/domain`, `packages/test-fixtures` — normalized
  contracts, snapshot state, transport limits, and typed M5 state fixtures
- Core/Connector protocol, race, artifact, batching, and lifecycle tests

**Commands and tests**

```text
pnpm --filter @aicl/connector codex:compatibility
→ compatible=true; Codex 0.146.0; canonical SHA b767c116...df03

pnpm migrate
→ Core schemaVersion=2; Connector schemaVersion=1

pnpm check
→ exit 0; strict typecheck; 41 tests; ESLint; Web production build

$env:AICL_REAL_CODEX='1'; pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
→ 1 passed in 73.64 s

git diff --check
→ exit 0
```

**Observable result and exact mobile/browser demo**

Run `pnpm dev`, create `output/playwright`, then open
`http://127.0.0.1:5173/?session=m4-approval-demo` at 390×844. Submit:

```text
Use the shell exactly once to run PowerShell command Set-Content -LiteralPath 'output/playwright/approval-proof.txt' -Value 'approved'. Do not use any other tool and do not modify other files.
```

The real Codex request appears in the bottom approval dock with command, cwd,
and expiry. **Approve once** completes the activity and creates only that proof
file. Repeat with a different filename and choose **Decline**; the activity becomes
`declined` and no file is created. The verified Playwright run used viewport
390×844 and produced 0 browser automation failures.

**Protocol/schema assumptions**

- Verified Codex 0.146.0 methods include command/file approval requests,
  item lifecycle, command output delta, file patch/diff, and Turn completion.
- Provider request IDs never cross Connector; Core/Web see an opaque correlation.
- Approval CAS uses approval revision and runtime/Turn/provider/expiry identity,
  never Session revision. Exactly one concurrent tab can dispatch a decision.
- Diffs stay inline only when content is at most 512 KiB and the serialized
  envelope at most 768 KiB. Otherwise they use 128 KiB journaled chunks and an
  opaque authenticated, range-capable artifact endpoint with SHA-256/length.

**Known limitations or uncertain outcomes**

- Artifact bearer tokens are process-ephemeral and distributed over the local
  browser WebSocket; this is a loopback Prototype 0 mechanism, not cloud auth.
- Command-output batches are intentionally ephemeral; completed activity keeps
  only a bounded preview, not an authoritative full transcript.
- Pending state lives on the Approval projection while the owning Turn remains
  `running` in schema v2; a richer Turn state machine is deferred beyond M4.

**Requested next action**

External AI gate reached: stop the Codex loop and run
`.\scripts\Invoke-GrokFrontend.ps1` for M5.1. After Grok writes its handoff, run
the Codex integration prompt; do not start Claude M6 before M5.2 passes.

---

### 2026-08-02 02:08 — Codex — Codex-only migration and M5.1

**Scope**

Remove Grok/Claude as blocking Prototype 0 gates, retain them as optional
post-prototype tools, and implement one milestone group: the functional M5.1
mission-control frontend backed exclusively by normalized Core state.

**Files changed or reviewed**

- `prompts/codex/08-CODEX-ONLY-PROTOTYPE-LOOP.md` — reusable loop prompt,
  verified SHA-256 `5ae38d97522bdf4930a2fd43694c3d50883ad6bb767a5420572bd514a07b5ddf`
- `AGENTS.md`, scope/workflow/status/execution docs, scripts and VS Code tasks —
  Codex owns M4–M7; external launchers are optional P1/P2 tools
- `packages/protocol/src/index.ts`, `apps/core/src/store.ts`,
  `apps/core/src/server.ts` — normalized Session catalog request/snapshot
- `apps/web/src/App.tsx`, `apps/web/src/state.ts`, `apps/web/src/styles.css` —
  Mission Overview, Session rail/selector, normalized timeline, recovery,
  activity/diff review, Approval Dock, composer, and responsive layout
- Protocol, Core, and Web tests plus typed mission-control fixtures

**Commands and tests**

```text
pnpm --filter @aicl/web check
→ 3 tests, typecheck, ESLint, and Vite production build passed

pnpm check
→ exit 0; 45 tests passed; one opt-in real-provider E2E skipped; strict
  typecheck, ESLint, Windows process-tree test, and production build passed

Playwright, AICL_PROVIDER=mock, 1440×1000 and 390×844
→ Session switch, Ctrl+Enter, streamed response, reload-safe unsent draft,
  and no automatic draft replay; 0 console warnings/errors

Playwright, real Codex, 390×844
→ Approve-once created only its proof file; decline created no target file;
  Approval Dock decisions remained visible; 0 console warnings/errors
```

**Observable result**

Run `pnpm dev`, open `http://127.0.0.1:5173`, select or open a Session,
submit a prompt, and observe real normalized activity in the stable timeline.
Refresh with an unsent draft to see it restored without dispatch. A provider
command approval stays at the bottom with evidence and both decisions visible;
the timeline remains inspectable above it.

**Protocol/schema assumptions**

- `sessions.snapshot` is an additive protocol-v1 Core read model, not a Codex
  provider projection. It uses existing schema-v2 tables; no migration is needed.
- A Session summary exposes only durable Core facts. Missing model/profile/token
  telemetry is omitted rather than synthesized.
- Durable sequence drives replay deduplication; ephemeral deltas use stable local
  identities and are replaced by authoritative completed messages.

**Known limitations or uncertain outcomes**

- Timeline display groups current projection rows by Turn because projections do
  not yet expose a complete display timestamp/sequence for every item.
- The timeline viewport is bounded, but 100k-event virtualization and automated
  DOM-level accessibility/overflow coverage remain M5.2 work.
- Runtime health is the latest normalized Connector runtime view; it is not
  invented as a per-Session provider metric.

**Requested next action**

Codex completes **M5.2** responsive, accessibility, and UX verification, records
evidence, and stops before the M6.1 correctness/recovery self-audit.

---

### 2026-08-02 02:45 — Codex — M5.2

**Scope**

Complete the responsive, accessibility, performance, and production-quality UX
pass without changing provider, protocol, or persistence boundaries.

**Files changed or reviewed**

- `apps/web/src/App.tsx` — compact Overview and Health/Diff drawers, focus
  restoration, live operational/approval announcements, and virtual timeline
- `apps/web/src/state.ts` — linear timeline grouping and bounded window math
- `apps/web/src/styles.css` — safe areas, 44 px targets, text wrapping,
  reduced-motion/forced-color behavior, and responsive drawer layout
- `apps/web/test/state.test.ts` — 100,000-item construction/window regressions
- `apps/web/README.md`, status, execution plan, and handoff documentation

**Commands and tests**

```text
pnpm --filter @aicl/web check
→ typecheck, 5 tests, ESLint, and Vite production build passed

pnpm check
→ exit 0; 47 tests passed; one opt-in real-provider E2E skipped; strict
  typecheck, ESLint, Windows process-tree test, and production build passed

Playwright viewport matrix: 375×812, 768×1024, 1024×768, 1440×1000
→ 0 page/body overflow; 0 enabled controls below 44×44 px

Playwright accessibility/scale checks
→ skip link focused `main`; drawer Escape restored trigger focus; token contrast
  5.59:1–18.31:1; reduced motion 0.01 ms/one iteration; 200% text 0 overflow

Playwright with real Codex at 375×812 and 200% text
→ both approval decisions fully visible; decline created no target file;
  terminal Turn completed; console 0 errors/0 warnings
```

**Observable result**

Run `pnpm dev` and open `http://127.0.0.1:5173`. At widths up to 860 px,
Overview starts collapsed and Health/Diff opens as a full-height drawer. Press
Escape to close it and return focus to its trigger. At every tested width,
timeline, composer, and approval controls fit without horizontal page overflow.

**Protocol/schema assumptions**

- M5.2 consumes the existing normalized protocol-v1 snapshot and catalog only;
  there is no protocol or SQLite migration.
- Streaming timeline text is intentionally not an ARIA live region. Operational
  state and approval count are announced separately to avoid speech flooding.
- Timeline windowing begins above 200 normalized items and retains stable item
  IDs plus `aria-posinset`/`aria-setsize` metadata.

**Known limitations or uncertain outcomes**

- Virtualized mode uses fixed 184 px rows with per-row scrolling for unusually
  large content. Dynamic-height virtualization is not required for Prototype 0.
- Browser verification is recorded here and in ignored Playwright artifacts;
  the committed regression suite covers projection/window math, not DOM layout.
- The mobile Health/Diff drawer is non-modal so a pending Approval Dock can keep
  operational priority above it.

**Requested next action**

Codex performs **M6.1** as an independent-style correctness/recovery self-audit,
records evidence-backed findings, and stops before M6.2 or remediation.

---

### 2026-08-02 03:09 — Codex — M6.1

**Scope**

Perform an independent-style correctness and recovery self-audit across Core,
Connector, Web reconstruction, SQLite constraints, command idempotency, event
ordering, approvals, artifacts, Runtime fencing, restart, and provider loss.
No finding remediation was included in this milestone.

**Files changed or reviewed**

- `reviews/codex/M6.1-CORRECTNESS-RECOVERY-AUDIT.md` — 12 findings with
  severity, affected symbols, reproduction, evidence, invariant, remediation,
  and regression-test proposal
- `apps/core/src/server.ts`, `apps/core/src/store.ts`, Core migrations/tests
- Connector journal, client, Codex adapter/RPC process, migrations/tests
- Web protocol reducer, timeline construction, and approval command state
- implementation status, execution plan, review index, and this handoff

**Commands and tests**

```text
Core targeted suites
→ durability/reconnect, approval races, database contract: 3 files / 11 passed

Connector targeted suites
→ journal, Codex adapter, output batching: 3 files / 12 passed

pnpm check
→ exit 0; 47 tests passed; one opt-in real-provider E2E skipped; strict
  typecheck, ESLint, Windows process-tree test, and Web build passed

Read-only Connector journal probe
→ first mismatch at event 0; 49/100 causal pairs replayed terminal-first

Read-only same-process reconnect probe
→ same boot/Runtime identity still produced turn.outcome_unknown

Read-only accept/dispatch crash-window probe
→ running Turn remained active with no reconciliation event after reopen
```

**Observable result**

Open `reviews/codex/M6.1-CORRECTNESS-RECOVERY-AUDIT.md`. The audit records six
High, five Medium, and one Low finding. Highest-risk items are non-FIFO Connector
replay, the Core accept-to-dispatch crash window, ambiguous RPC timeout handling,
and incorrect Runtime/process ownership recovery.

**Verified controls and falsification**

- Command deduplication/conflict handling, serialized Core writes,
  commit-before-broadcast, approval CAS, ordered artifact integrity checks,
  provider-exit invalidation, no automatic prompt replay, and Windows process
  teardown remain verified.
- A suspected snapshot-to-live subscription gap was falsified because the final
  subscription/replay block has no asynchronous yield.

**Known limitations or uncertain outcomes**

- Findings are deliberately not fixed in M6.1. M7.1 owns accepted remediation
  and regression tests after both self-audit lenses are complete.
- Security exploitability and boundary-hardening conclusions are outside this
  milestone and must be established independently in M6.2.

**Requested next action**

Codex performs **M6.2** as a security/boundary self-audit, records independently
reproducible findings, and stops before M7.1 remediation.

---

### 2026-08-02 03:26 — Codex — M6.2

**Scope**

Perform a separate security and boundary self-audit of browser/Core/Connector
identity, Origin, schemas, payload/rate ceilings, artifact retrieval/allocation,
project-root containment, Windows path/spawn behavior, secret handling, browser
rendering, and approval replay. No remediation was included.

**Files changed or reviewed**

- `reviews/codex/M6.2-SECURITY-BOUNDARY-AUDIT.md` — separate Standards and Spec
  findings with severity, affected symbols, reproduction, evidence, expected
  boundary, remediation, and regression-test proposal
- Core WebSocket/HTTP server, artifact store, normalized protocol schemas
- Connector client/journal, Codex adapter/RPC process, process command helper
- Web rendering and approval resolution paths
- implementation status, execution plan, and this handoff

**Commands and tests**

```text
Core targeted suites
→ artifact flow and approval races: 2 files / 6 passed

Protocol targeted suite
→ validation: 1 file / 6 passed

Connector targeted suites
→ command construction, transport, Windows process tree: 3 files / 5 passed

Hostile-Origin browser/Connector probe
→ artifact token disclosed; cross-origin mutation accepted; forged Connector
  received INTERCEPTED_SECRET_PROMPT

Secret redaction probe
→ provider error bearer canary reached browser protocol.error unchanged

Schema/allocation probe
→ huge artifact declaration accepted; decoded chunk 196608 > 131072;
  completed-message envelope 1049044 > 1048576 WebSocket ceiling

Browser rate probe
→ 500 requests / 500 replies; no throttle or close

pnpm check
→ first run: one Core-restart recovery test timed out at 5 s
→ targeted rerun: durability/reconnect 3/3 passed; affected case 208 ms
→ full rerun: exit 0; 47 passed, one opt-in real-provider E2E skipped;
  strict typecheck, ESLint, Windows process-tree test, and Web build passed
```

**Observable result**

Open `reviews/codex/M6.2-SECURITY-BOUNDARY-AUDIT.md`. The review skill preserves
6 Standards findings and 6 Spec findings as separate axes; their overlap maps to
eight implementation themes. The worst Standards findings are unauthenticated
browser control and Connector impersonation, both Critical.

**Verified controls and falsification**

- Loopback binding, strict normalized schemas, the 1 MiB WebSocket ceiling,
  bounded prompt/output batching, artifact bearer/hash/range/path checks,
  stale-approval CAS, React text escaping, no unrestricted shell endpoint, and
  Windows process-tree termination remain verified controls.
- No remotely controlled process-spawn argument reaches the current Windows
  `shell: true` invocation, so command injection was not claimed without an
  exploit. This must be revisited if command selection becomes remote.

**Known limitations or uncertain outcomes**

- M6.2 findings intentionally overlap between review axes and are not fix-counts.
  M7.1 must deduplicate implementation work while retaining every source ID.
- Application authentication can remain minimal and local for Prototype 0, but
  hostile Origin and Connector takeover paths cannot pass the final gate.
- One full-check run exposed a transient recovery-test timeout under concurrent
  workspace checks. It did not reproduce alone or on the next full run; M7.1
  should retain this evidence when touching recovery timing.

**Requested next action**

Codex performs **M7.1**: create a traceable remediation register, reproduce and
resolve accepted M6.1/M6.2 findings with regression tests, and stop before M7.2.

---

### 2026-08-02 04:16 — Codex — M7.1

**Scope**

Deduplicate all M6.1/M6.2 findings, accept the 17 Prototype 0 remediation
themes, repair them with regression coverage, and stop before the clean-checkout
real-provider gate.

**Files changed or reviewed**

- `reviews/codex/M7.1-REMEDIATION-REGISTER.md` — source finding map, policy
  clarifications, implemented controls, and regression evidence
- `packages/protocol` — capability transport, receipt/outcome envelopes,
  display sequence, media allowlist, and decoded payload ceilings
- `apps/core` — authenticated upgrades, exact Origin, rate/heartbeat controls,
  bounded artifacts, passive expiry, receipt/lease recovery, durable command
  outcomes, Runtime concurrency, display sequencing, and schema v3 guards
- `apps/connector` — authenticated client, FIFO schema v2, receipts, canonical
  project containment, provider environment isolation, timeout/loss handling,
  and stable redacted errors
- `apps/web` — per-launch capability, approval-command correlation, durable
  cross-type chronology, and Runtime-busy submission state
- `scripts/Start-Dev.ps1`, `.env.example`, README, status, and execution plan

**Commands and tests**

```text
pnpm check
→ exit 0; 65 passed, one opt-in real-provider E2E skipped; strict typecheck,
  ESLint, Windows process-tree test, and Web production build passed

pnpm migrate
→ exit 0; Core schemaVersion=3; Connector schemaVersion=2

git diff --check
→ exit 0
```

**Observable result**

Browser and Connector control planes now require separate launch capabilities;
the browser also requires an exact allowed Origin. Provider execution is limited
to canonical operator roots and an explicit child environment. Oversized,
malformed, burst, dead-peer, unsafe artifact, and secret-bearing error paths all
fail closed. Restart ambiguity converges using durable receipts and an ownership
lease without automatic prompt replay.

**Verified controls and regressions**

- Same-timestamp Connector outbox entries replay in insertion order.
- A merely `received` command is not dispatch proof; missing ownership after
  reconnect/startup becomes `outcome_unknown` and is not redispatched.
- RPC timeout/provider loss, passive approval expiry, late decisions, uncertain
  Connector command delivery, and one-Runtime concurrency are terminalized.
- Timeline order follows Core display sequence; rejected approval commands
  release the correct Web control; SQLite rejects illegal command transitions.

**Known limitations or uncertain outcomes**

- Prototype authentication remains a per-launch local capability, not the
  long-term passkey/device identity design.
- The opt-in real Codex test and clean-checkout operator demo were intentionally
  not run in M7.1; both belong to M7.2.

**Requested next action**

Codex performs **M7.2** from a clean checkout: migrate, run normal and opt-in
real-provider gates, execute the documented browser demo/fault paths, record
final evidence, and complete Prototype 0.

---

### 2026-08-02 05:50 — Codex — M7.2

**Scope**

Run the final clean-checkout, real-provider, browser, durability, recovery, and
security gates; repair only failures exposed by that evidence; complete
Prototype 0.

**Files changed or reviewed**

- `apps/connector/src/codex/adapter.ts` and adapter fixtures/tests — reconcile
  terminal Turn items and normalize plain add/delete content to unified diff
- `packages/protocol`, Core schema v4, and Core recovery tests — represent and
  persist `outcome_unknown`; terminalize dangling activity/file-change records
- `apps/core/test/real-codex.e2e.test.ts` — prove lost Runtime rejection and
  resume from a new Connector process without prompt replay
- README, status, execution plan, this handoff, and the M7.2 evidence report

**Commands and tests**

```text
compatibility → Codex 0.146.0 accepted; canonical schema SHA-256
b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03

pnpm migrate (twice) → Core v4 / Connector v2, idempotent
pnpm check → 66 passed; opt-in real E2E skipped; typecheck/lint/build passed
opt-in real Codex E2E → 1 passed in 66.70 s
git diff --check → exit 0
```

**Observable result**

Playwright drove the real React/Core/Connector/Codex path. It observed the exact
first response, refresh/replay, decline with no side effect, approve-once with
exit code/output, approved file diff with `+1/−0` in unified and split views,
Connector generation recovery, and an interrupted long command. Browser console
reported zero errors and zero warnings.

**Repairs discovered by the final gate**

- The real E2E expected a lost Connector generation to restart its provider;
  it now starts a new Connector on the durable journal and proves the old
  generation rejects commands.
- Codex 0.146 may include a terminal command/file item only in `turn/completed`;
  the adapter now reconciles it once instead of leaving the UI at `RUNNING`.
- Added/deleted file content may arrive without unified headers; normalization
  now produces correct counts and before/after review.
- Core now closes any remaining work projection at every terminal boundary,
  including the explicit `outcome_unknown` state.

**Known limitations or uncertain outcomes**

- Prototype authentication remains a local per-launch capability, not the
  long-term device/passkey design.
- On Windows, install/run from a canonical long path. An 8.3 path alias caused
  Vite `/@vite/client` resolution to fail despite an unchanged checkout.

**Requested next action**

Prototype 0 is complete. Stop here. P1 Grok refinement, P2 Claude independent
audit, and P3 Codex feedback integration are optional operator-selected phases.

---

### 2026-08-02 23:49 — Codex — M8.1

**Scope**

Start the post-Prototype daily-use phase with one same-origin production-host
slice. Do not begin runtime ticket authentication or Windows lifecycle work.

**Files changed**

- `apps/core/src/static-host.ts`, `apps/core/src/server.ts` — serve the built Web
  root safely, reserve protocol routes, and admit the exact Core HTTP Origin
- `apps/web/src/runtime.ts`, `apps/web/src/App.tsx` — derive same-origin `ws/wss`
  while preserving an explicit Vite override
- `scripts/Start-Dev.ps1` — keep the existing split-port development flow
- `scripts/Invoke-Codex.ps1`, `scripts/Show-NextStep.ps1` — make one-round
  automation select the active M8 prompt
- Core/Web tests and M8 status, plan, prompt, README, and architecture notes

**Commands and tests**

```text
targeted red tests → root 404 and same-origin WebSocket 403 reproduced
targeted Core/Web tests → 7 passed
pnpm --filter @aicl/web build → pass, 42 modules
real built-dist process smoke → health/index/asset/fallback 200; listener cleaned
pnpm check → 70 passed; opt-in real Codex E2E skipped; typecheck/lint/build pass
git diff --check → exit 0
```

The first full gate exposed SPA fallback masking the existing normalized
artifact-traversal probe with HTTP 200. Fallback is now limited to requests that
accept `text/html`; the artifact test and production navigation smoke both pass.

**Observable result**

Core serves `index.html`, immutable Vite assets, and HTML navigation fallback
from the same loopback origin as `/ws`. Health, Connector, WebSocket, and
artifact paths are not shadowed. Missing assets and traversal-shaped requests
remain 404.

**Known limitations**

- Production Web authentication still depends on the existing build-time
  browser capability. Do not expose M8.1 remotely before M8.2.
- Production compiled start/stop, persistent config, Tailscale, and backup are
  intentionally deferred to M8.3–M8.6.
- No second-device/tailnet claim was made in this milestone.

**Requested next action**

Execute **M8.2 runtime browser authentication** only: bounded same-origin
bootstrap tickets with expiry, replay, hostile-Origin, and restart coverage.

---

### 2026-08-03 03:55 — Codex — M8.2

**Scope**

Replace production build-time browser capability injection with bounded runtime
WebSocket tickets. Preserve Connector authentication and all prior trust tests;
do not begin LocalAppData configuration.

**Files changed**

- `apps/core/src/browser-tickets.ts`, `apps/core/src/server.ts`, `main.ts` —
  bounded digest-only ticket registry, exact-Origin bootstrap, one-time consume,
  and production legacy-token disablement
- `packages/protocol` — strict runtime-config schema and capability parser
- `apps/web/src/runtime.ts`, `App.tsx` — validated ticket fetch on every
  connect/reconnect without URL or browser-storage persistence
- `scripts/Start-Dev.ps1`, Vite config — remove legacy browser env and explicitly
  disable production source maps
- runtime auth, protocol, Web tests and milestone documentation

**Commands and tests**

```text
runtime-auth red test → 4/4 failed against missing endpoint/ticket path
Core runtime-auth + security → 7 passed
Protocol runtime schema → 10 passed
Web runtime bootstrap → 4 passed
pnpm check → 77 passed; opt-in real Codex E2E skipped; typecheck/lint/build pass
git diff --check → exit 0
```

Playwright loaded the built app from Core at `http://127.0.0.1:8797`, observed
`POST /runtime-config` 200 on initial load and again after reload, and rendered
Core online/synchronized. Console reported zero errors and zero warnings;
localStorage was empty. The temporary Core/browser were closed and port 8797
was released. The operator's pre-existing dev stack was not stopped.

**Security and recovery evidence**

- Ticket TTL is 30 seconds; outstanding allocation defaults to 128.
- Core stores SHA-256 ticket digests, not bearer values.
- Ticket use is exact-Origin and one-time; hostile Origin does not consume it.
- Body-bearing bootstrap requests fail 413 and capacity excess fails 503.
- Expired, replayed, legacy-production, and pre-restart tickets fail 401.
- Connector capability logic is unchanged and separate.
- Production build contains no legacy browser env name/value and emits no maps.

**Known limitations**

- The ticket proves a same-origin runtime bootstrap, not a passkey/operator
  identity. Core remains loopback-only; M8.5 owns private tailnet exposure.
- A dev stack started before M8.1 must be restarted so Vite receives the explicit
  Core URL override; hot reload cannot add environment variables retroactively.
- Persistent paths/configuration remain shell/environment driven until M8.3.

**Requested next action**

Execute **M8.3 persistent local configuration** only: typed versioned config
under LocalAppData, environment overrides, and canonical path validation.
