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
