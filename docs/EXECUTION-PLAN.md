# Active Execution Plan

## Purpose and observable outcome

M0 (measurements), M1 (walking skeleton), M2 (real first-token vertical slice),
and M3 (durability/reconnect) are complete on the target Windows host. The next
observable outcome is normalized command output, approval CAS, and artifact-
backed diff delivery (M4.1–M4.3).

## Scope

- M0.1 target-Windows toolchain verification — **done**
- M0.2 three real Codex app-server spikes — **done**
- M0.3 measurement document and compatibility notes — **done**
- M1.1–M1.3 walking skeleton — **done**
- M2.1–M2.3 real Codex vertical slice and fault semantics — **done**
- M3.1–M3.3 SQLite durability, idempotency, replay, and refresh — **done**
- Next: M4.1 command output and file-change normalization (Codex-owned)

## Non-goals

- Anything excluded by `docs/00-PROTOTYPE-0-SCOPE.md`
- Grok frontend pass before protocol packages exist
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

## Protocol or schema changes

`@aicl/protocol` version 1 now includes provider bindings, interrupt commands,
Connector source identity, runtime generations, journal acknowledgements, and
browser replay boundaries. Durable event envelopes carry Session-local sequence;
assistant deltas remain ephemeral. Generated Codex types and raw events stay
under the adapter boundary; the Web imports only normalized protocol types.

## Tests and fault scenarios

- `.\scripts\Check-Toolchain.ps1` passed (Git 2.54.0, Node 24.16.0, Codex 0.146.0).
- Mock spike passed after harness fix.
- Three real spikes: first-delta 4.5–6.3 s; ~55 deltas/s avg; peak 1 s up to 154;
  mid-turn kill reconstructed as `interrupted` via `thread/read` + `thread/resume`.
- `pnpm check`: strict typecheck, 26 unit/integration tests, ESLint, a real
  Windows child-tree termination test, and Vite production build passed.
- Live compatibility probe: Codex 0.146.0, 275 schema files, canonical SHA-256
  `b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03`.
- Opt-in real Codex E2E passed in 70.33 s: first delta/final, active rejection,
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
- Process cleanup verified no listeners on 5173/8787/8788 and no project Codex
  process remained.

## Surprises and measurements

- Unquoted Windows `shell: true` spawn broke `Program Files\nodejs\node.exe`.
- Raw schema fingerprint differed because generated object-key order varied;
  recursive canonical JSON produces a stable fingerprint across generations.
- Kill recovery is terminal `interrupted` on this CLI (not silent loss-only).
- Steady agent-delta payload ~253–263 bytes; ephemeral batching is mandatory.

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

## Final outcome

M0 through M3 complete. Reproduce the normal and opt-in gates with:

```powershell
.\scripts\Check-Toolchain.ps1
pnpm --filter @aicl/connector codex:compatibility
pnpm migrate
pnpm check
pnpm dev
$env:AICL_REAL_CODEX = '1'
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
```

Next: `prompts/codex/05-APPROVAL-INTERRUPT-AND-DIFF.md` for M4.1–M4.3.
