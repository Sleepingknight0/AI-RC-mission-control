# Active Execution Plan

## Purpose and observable outcome

M0 (toolchain + empirical spike + measurements) is complete on the target
Windows host. Product scaffolding has not started. Next observable outcome is
a walking skeleton monorepo with Core and Connector as separate processes and a
mock normalized WebSocket path (M1.1–M1.3).

## Scope

- M0.1 target-Windows toolchain verification — **done**
- M0.2 three real Codex app-server spikes — **done**
- M0.3 measurement document and compatibility notes — **done**
- Next: M1.1–M1.3 walking skeleton (Codex-owned)

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
- Product packages (`apps/*`, `packages/*`) still README stubs only

## Implementation sequence

- [x] Inspect repository and target milestone
- [x] Run the repository toolchain check
- [x] Fix Windows `shell: true` path quoting in spike harness
- [x] Verify mock spike harness
- [x] Run three real Codex app-server spikes
- [x] Fill CODEX-SPIKE-RESULTS and mark M0 complete
- [ ] Scaffold pnpm strict-TypeScript monorepo (M1.1)
- [ ] Run Core and Connector as separate processes (M1.2)
- [ ] Demonstrate mock normalized WebSocket flow (M1.3)

## Protocol or schema changes

None in product code yet. Installed Codex 0.146.0 schemas generated under each
spike run `schema/` directory (275 files). Required method strings present.

## Tests and fault scenarios

- `.\scripts\Check-Toolchain.ps1` passed (Git 2.54.0, Node 24.16.0, Codex 0.146.0).
- Mock spike passed after harness fix.
- Three real spikes: first-delta 4.5–6.3 s; ~55 deltas/s avg; peak 1 s up to 154;
  mid-turn kill reconstructed as `interrupted` via `thread/read` + `thread/resume`.

## Surprises and measurements

- Unquoted Windows `shell: true` spawn broke `Program Files\nodejs\node.exe`.
- Schema fingerprint SHA-256 differed across three identical-size generations.
- Kill recovery is terminal `interrupted` on this CLI (not silent loss-only).
- Steady agent-delta payload ~253–263 bytes; ephemeral batching is mandatory.

## Decision log

- Apply Windows spawn fix in the spike harness so M0 can complete on this host.
- Treat kill→`interrupted` as mappable terminal status; never auto-resubmit.
- Defer monorepo scaffold to M1 under Codex ownership per `AGENTS.md`.
- Use measured rates for future batching defaults (see measurement doc table).

## Final outcome

M0 complete. Reproduce with:

```powershell
.\scripts\Check-Toolchain.ps1
pnpm run spike:mock
# optional re-run: .\scripts\Run-CodexSpike.ps1 -Runs 3
```

Next: `prompts/codex/02-SCAFFOLD-WALKING-SKELETON.md` for M1.1–M1.3.
