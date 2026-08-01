# Implementation Status

Codex must execute the first incomplete milestone unless the operator explicitly selects another prompt.

## Milestones

- [x] M0.1 Toolchain checked on target Windows
- [x] M0.2 Codex empirical spike completed at least three times
- [x] M0.3 Measurements and compatibility notes recorded
- [x] M1.1 pnpm strict-TypeScript monorepo scaffolded
- [x] M1.2 Core and Connector run as separate processes
- [x] M1.3 Mock normalized WebSocket flow demonstrated
- [x] M2.1 Installed Codex schema compatibility gate implemented
- [x] M2.2 Real browser-to-Codex first-token path demonstrated
- [x] M2.3 interrupt, active-Turn rejection, and provider-loss semantics tested
- [ ] M3.1 Core SQLite WAL and Connector journal implemented
- [ ] M3.2 command idempotency and event replay implemented
- [ ] M3.3 browser refresh during active Turn tested
- [ ] M4.1 command output and file-change normalization implemented
- [ ] M4.2 approval compare-and-set implemented and race-tested
- [ ] M4.3 artifact-backed large diff flow implemented
- [ ] M5.1 Grok frontend implementation pass completed
- [ ] M5.2 Codex integrated and verified frontend pass
- [ ] M6.1 Claude correctness review completed
- [ ] M6.2 Claude security/recovery review completed
- [ ] M7.1 Codex triaged and resolved accepted findings
- [ ] M7.2 clean-checkout prototype demo and final gate completed

## Current blocker

None. Next milestone: **M3.1** — implement Core SQLite WAL and the Connector journal (`prompts/codex/04-DURABILITY-AND-RECONNECT.md`).

## Last verified demo

- Toolchain: `.\scripts\Check-Toolchain.ps1` — required tools OK (Git 2.54.0, Node v24.16.0, Codex 0.146.0).
- Mock spike harness: `pnpm run spike:mock` — pass after Windows spawn quoting fix.
- Real spikes: `.\scripts\Run-CodexSpike.ps1 -Runs 3` — batch `spikes/codex-app-server/artifacts/real-20260801-091022/` (3/3 exit 0).
- Measurements: `docs/measurements/CODEX-SPIKE-RESULTS.md`.
- Compatibility gate: installed Codex 0.146.0 accepted with canonical schema SHA-256 `b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03`; 275 generated schema files are adapter-internal.
- Repository checks: `pnpm check` — strict typecheck, 19 tests, ESLint, Windows process-tree test, and Web production build passed; the opt-in real test remained skipped.
- Real Codex E2E: opt-in test passed in 71.39 s, covering first delta/final, `TURN_ALREADY_ACTIVE`, interrupt, provider kill → `outcome_unknown`, new-process resume, and no command replay.
- Browser demo: Playwright drove React → Core → Connector → real Codex and rendered 80 streamed lines; a fresh browser restored the completed snapshot with 0 console errors and 0 warnings.
