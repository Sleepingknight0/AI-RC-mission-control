# Active Execution Plan

## Purpose and observable outcome

M0 (toolchain + empirical spike + measurements) and the M1 walking skeleton are
complete on the target Windows host. The next observable outcome is the real
browser-to-Codex first-token path, starting with the installed-schema
compatibility gate (M2.1–M2.3).

## Scope

- M0.1 target-Windows toolchain verification — **done**
- M0.2 three real Codex app-server spikes — **done**
- M0.3 measurement document and compatibility notes — **done**
- M1.1–M1.3 walking skeleton — **done**
- Next: M2.1 installed Codex schema compatibility gate (Codex-owned)

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
- Deterministic mock Connector streams through Core to WebSocket subscribers

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
- [ ] Add installed Codex schema compatibility gate (M2.1)
- [ ] Demonstrate real browser-to-Codex first token (M2.2)
- [ ] Test interrupt, active-Turn rejection, and provider-loss semantics (M2.3)

## Protocol or schema changes

`@aicl/protocol` now defines protocol version 1 client, server, Core-to-Connector,
and Connector-to-Core envelopes. Every WebSocket boundary parses strict Zod
schemas. Provider-specific mock fields terminate in `apps/connector`; frontend
messages contain normalized fields only. Installed Codex 0.146.0 schemas remain
spike artifacts and are not yet wired into product code.

## Tests and fault scenarios

- `.\scripts\Check-Toolchain.ps1` passed (Git 2.54.0, Node 24.16.0, Codex 0.146.0).
- Mock spike passed after harness fix.
- Three real spikes: first-delta 4.5–6.3 s; ~55 deltas/s avg; peak 1 s up to 154;
  mid-turn kill reconstructed as `interrupted` via `thread/read` + `thread/resume`.
- `pnpm check`: strict typecheck, 6 unit/integration tests, ESLint, and Vite
  production build passed.
- Core integration test: normalized mock streaming passed; concurrent submit
  returned `TURN_ALREADY_ACTIVE`; fresh WebSocket subscription restored the
  completed snapshot; no raw-provider keys reached browser output.
- `pnpm dev` smoke: Web 5173, Core 8787, Connector 8788; both health endpoints
  ready and Core observed the Connector.

## Surprises and measurements

- Unquoted Windows `shell: true` spawn broke `Program Files\nodejs\node.exe`.
- Schema fingerprint SHA-256 differed across three identical-size generations.
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

## Final outcome

M0 and M1 complete. Reproduce with:

```powershell
.\scripts\Check-Toolchain.ps1
pnpm run spike:mock
pnpm check
pnpm dev
```

Next: `prompts/codex/03-FIRST-TOKEN-VERTICAL-SLICE.md` for M2.1–M2.3.
