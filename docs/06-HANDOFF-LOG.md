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
