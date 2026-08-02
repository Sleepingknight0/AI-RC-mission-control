# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

# Claude Code role

Unless the user explicitly assigns implementation work, act as an independent read-only reviewer for this repository.

- Use `plan` permission mode.
- Do not edit source files.
- Review the current diff and relevant tests.
- Write prioritized findings to `reviews/claude/` when invoked through the provided script.
- Focus on correctness, concurrency, state machines, database constraints, Windows process behavior, security boundaries, and recovery semantics.
- Avoid generic praise or speculative feature expansion.
- A finding must include severity, file/line evidence, failure scenario, and minimal remediation.

The active prompt under `prompts/claude/` defines the review scope.

# Commands

pnpm workspace (`pnpm@10.14.0`), run from the repository root on Windows PowerShell.

```powershell
pnpm install
pnpm migrate    # core + connector schema migrations; idempotent, safe to re-run
pnpm dev        # scripts/Start-Dev.ps1 -> pnpm -r --parallel run dev
pnpm check      # THE gate: typecheck + test + lint in every package, plus the web production build
```

Narrower loops:

```powershell
pnpm test | pnpm typecheck | pnpm lint          # fan out to every package
pnpm --filter @aicl/core check                  # one package, full gate
pnpm status                                     # print first unchecked milestone + suggested prompt
```

Single test file / single test name (each app runs its own `vitest run`, there is no root vitest config):

```powershell
pnpm --filter @aicl/core exec vitest run test/approval-races.test.ts
pnpm --filter @aicl/connector exec vitest run test/journal.test.ts -t "FIFO"
```

Provider-dependent commands:

```powershell
pnpm --filter @aicl/connector codex:compatibility   # probe installed codex binary vs pinned fingerprint
pnpm run spike:mock                                 # app-server spike harness against the mock codex
.\scripts\Run-CodexSpike.ps1 -Runs 3                # real spike, writes spikes/codex-app-server/artifacts/

$env:AICL_REAL_CODEX = '1'                          # opt-in; skipped in normal runs to save quota
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
```

`scripts/Invoke-Codex.ps1` (implementation), `Invoke-GrokFrontend.ps1`, and `Invoke-ClaudeReview.ps1` pipe a
prompt file to the corresponding CLI. `Invoke-ClaudeReview.ps1` hard-restricts the review to `Read,Glob,Grep`
in plan mode and tees the report into `reviews/claude/`.

# Architecture

## Process topology

```text
browser (Vite dev :5173, or Core-hosted apps/web/dist)
  -> Core  ws://127.0.0.1:8787/ws          + POST /runtime-config, GET /health, GET /artifacts/{id}
  -> Connector  ws .../connector           + health :8788
  -> codex app-server --stdio  (or AICL_PROVIDER=mock)
```

Core and Connector are always separate OS processes, even on one host, so Core survives provider death.
`scripts/Start-Dev.ps1` mints a fresh `AICL_CONNECTOR_TOKEN` per launch, sets `VITE_CORE_WS_URL`, and defaults
`AICL_PROJECT_ROOTS`/`AICL_PROJECT_PATH` to the repository root — nothing is persisted between launches.

## Where the logic actually lives

| Concern | File |
|---|---|
| All wire schemas, size limits, redaction, capability tokens | `packages/protocol/src/index.ts` |
| Core HTTP/WS server, auth, rate limits, connector channel | `apps/core/src/server.ts` |
| Core SQLite writer: projections, CAS, replay, artifacts | `apps/core/src/store.ts` |
| One-time browser WebSocket tickets | `apps/core/src/browser-tickets.ts` |
| Production static hosting + reserved paths / SPA fallback | `apps/core/src/static-host.ts` |
| Connector socket loop, journal dispatch, artifact chunking | `apps/connector/src/client.ts` |
| Provider interface every adapter implements | `apps/connector/src/provider.ts` |
| Codex normalization boundary (raw events stop here) | `apps/connector/src/codex/adapter.ts` |
| Codex stdio process + JSON-RPC framing | `apps/connector/src/codex/{rpc-process,line-framer}.ts` |
| Version/schema gate against the installed binary | `apps/connector/src/codex/compatibility.ts` |
| Connector durable inbox/outbox journal | `apps/connector/src/journal.ts` |
| Browser reducer over normalized frames | `apps/web/src/state.ts` |

`packages/domain` is the pure Session/Turn state machine (`beginTurn`, `finishTurn`, `toSnapshot`) with no I/O —
prefer it for transition-logic changes over inlining rules into `store.ts`.

## Invariants that span files

These are the ones that are easy to break with a local-looking edit; the full list is in `AGENTS.md` and
`docs/01-ARCHITECTURE-DECISIONS.md`.

- **Normalization boundary.** Raw Codex JSON is parsed by zod schemas inside `codex/adapter.ts` and converted to
  `ConnectorEnvelope`. `apps/web` may only import `@aicl/protocol` and `@aicl/domain`; it must never see a
  provider type or reach `node:sqlite`.
- **Two SQLite files, two owners.** Core owns `.data/aicl-core.db` (schema v4, WAL, strict tables, single
  serialized writer). Connector owns `.data/aicl-connector.db` (schema v2, FIFO journal). Connector never opens
  the Core database. Both are `node:sqlite` `DatabaseSync` — synchronous, no better-sqlite3.
- **Durable commits before broadcast; deltas stay ephemeral.** Token/output/reasoning deltas are coalesced
  (`output-batcher.ts`) and never written one-per-transaction. `last_event_seq` (replay) and per-resource
  revisions (Session/Turn/Approval) are independent counters.
- **Approval resolution is row-level CAS** over approval id+revision, pending state, runtime id+generation, turn
  identity, provider request id, and expiry — never the fast-moving session revision. See
  `store.ts:resolveApproval` and `test/approval-races.test.ts`.
- **No provider reattach.** A Connector restart loses the runtime; the old Runtime becomes `lost`, resume creates
  a new generation, and an unfinished Turn becomes `outcome_unknown`. Ambiguous side effects are never replayed —
  `commandId` deduplicates at the Core boundary only, it is not exactly-once across the process boundary.
- **One executing Turn per Session.** A second submit returns `TURN_ALREADY_ACTIVE`; there is no `queued` state.
- **Payload ladder.** `MAX_INLINE_DIFF_BYTES` (512 KiB) < `MAX_INLINE_ENVELOPE_BYTES` (768 KiB) <
  `MAX_WEBSOCKET_MESSAGE_BYTES` (1 MiB). Anything over an inline limit is chunked through the Connector journal
  and fetched from `/artifacts/{id}` with the ephemeral token from `server.hello`. Keep that ordering.
- **Project roots are canonicalized against an allowlist** (`connector/src/project-root.ts`);
  `AICL_PROJECT_ROOTS` is `;`-separated on Windows. Core never touches project files.

## Environment variables

Read directly by the code (there is no dotenv loader — export them in the shell or let `Start-Dev.ps1` do it):

`AICL_CORE_PORT`, `AICL_CONNECTOR_PORT`, `AICL_CONNECTOR_TOKEN` (required by both processes),
`AICL_BROWSER_ORIGINS`, `AICL_CORE_CONNECTOR_URL`, `AICL_PROVIDER` (`codex` | `mock`), `AICL_PROJECT_ROOTS`,
`AICL_PROJECT_PATH`, `AICL_CORE_DB_PATH`, `AICL_CONNECTOR_DB_PATH`, `AICL_WEB_DIST_PATH`, `VITE_CORE_WS_URL`,
`AICL_REAL_CODEX`.

`.env.example` is stale: it advertises `AICL_CORE_DB`/`AICL_CONNECTOR_DB` (the code reads the `_PATH` suffixed
names) and browser-token variables that M8.2 replaced with `/runtime-config` tickets.

# Milestone workflow

`docs/05-IMPLEMENTATION-STATUS.md` is the live checklist and names the current milestone; execute only the first
unchecked one unless the user names another. Prototype 0 (M0–M7.2) is complete; M8 daily-use operationalization
is active, currently at **M8.3**. Every milestone ends by updating `docs/05-IMPLEMENTATION-STATUS.md`,
`docs/06-HANDOFF-LOG.md`, and `docs/EXECUTION-PLAN.md` with the exact commands and results that were run.

Reviews live in `reviews/{codex,claude,grok}/`; `reviews/codex/M7.1-REMEDIATION-REGISTER.md` maps prior accepted
findings to the controls and regression tests that closed them.

# Windows gotchas

- The final clean-checkout gate must use a fully expanded path. Cloning into an 8.3 short path (`BLUEWH~1`)
  produces pnpm junctions where Vite cannot resolve `/@vite/client`.
- `node:sqlite` needs a newer runtime than `engines.node: >=20` implies; the toolchain check only enforces 20,
  and the verified configuration is Node 24.16.0 with Codex 0.146.0.
- The compatibility gate pins one exact Codex CLI version plus a canonical schema SHA-256. A Codex upgrade fails
  the gate by design — regenerate `codex/generated/` and re-measure rather than loosening the check.
- Process-tree termination, stdio closure, and path handling are asserted on Windows
  (`connector/test/windows-process-tree.test.ts`); do not infer them from POSIX behavior.
