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
- [x] M3.1 Core SQLite WAL and Connector journal implemented
- [x] M3.2 command idempotency and event replay implemented
- [x] M3.3 browser refresh during active Turn tested
- [x] M4.1 command output and file-change normalization implemented
- [x] M4.2 approval compare-and-set implemented and race-tested
- [x] M4.3 artifact-backed large diff flow implemented
- [x] M5.1 Codex mission-control frontend implemented
- [x] M5.2 Codex responsive, accessibility, and UX pass completed
- [ ] M6.1 Codex correctness/recovery self-audit completed
- [ ] M6.2 Codex security/boundary self-audit completed
- [ ] M7.1 Codex resolved accepted self-audit findings with regression tests
- [ ] M7.2 clean-checkout prototype demo and final gate completed

## Optional post-Prototype phases

- P1 Grok visual hierarchy and UX refinement
- P2 Claude independent correctness/security audit
- P3 Codex triage of reproducible external feedback

## Current milestone

No external AI gate. Next milestone: **M6.1** — Codex performs an
independent-style correctness and recovery self-audit.

## Last verified demo

- Toolchain: `.\scripts\Check-Toolchain.ps1` — required tools OK (Git 2.54.0, Node v24.16.0, Codex 0.146.0).
- Mock spike harness: `pnpm run spike:mock` — pass after Windows spawn quoting fix.
- Real spikes: `.\scripts\Run-CodexSpike.ps1 -Runs 3` — batch `spikes/codex-app-server/artifacts/real-20260801-091022/` (3/3 exit 0).
- Measurements: `docs/measurements/CODEX-SPIKE-RESULTS.md`.
- Compatibility gate: installed Codex 0.146.0 accepted with canonical schema SHA-256 `b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03`; 275 generated schema files are adapter-internal.
- Database schema: Core schema version 2 and Connector schema version 1; `pnpm migrate` is idempotent. Core adds durable activity/file-change/approval/artifact projections while Connector retains its separate inbox/outbox journal.
- Repository checks: `pnpm check` — strict typecheck, 47 tests, ESLint, Windows process-tree test, and Web production build passed; the opt-in real test remained skipped.
- Real Codex E2E: opt-in test passed in 73.64 s, covering first delta/final, `TURN_ALREADY_ACTIVE`, interrupt, provider kill → `outcome_unknown`, new-process resume, no command replay, and deterministic provider teardown.
- Recovery tests: durable command race/deduplication, replay sequence, runtime-generation fencing, Connector restart, Core restart, and commit-before-broadcast failure all passed.
- M4 race/fault tests: exactly one of two tabs wins approval CAS; duplicate command IDs replay; expiry/provider loss/runtime restart reject stale decisions; interrupt, UTF-8 batching, inline/large diff thresholds, artifact integrity/auth/range/traversal all pass.
- Mobile approval demo: Playwright at 390×844 used real Codex command approvals. Approve-once created only `output/playwright/provider-approval-proof.txt`; decline produced activity state `declined` and did not create its target file.
- M5.1 browser demo: real Session catalog, selectable desktop/mobile sessions, normalized timeline, activity and diff review, recovery truth, keyboard submission, local draft recovery, and approval actions all rendered from protocol state. Mock desktop/mobile and real Codex approve/decline paths completed with zero console warnings or errors.
- M5.2 UX gate: Playwright verified 375/768/1024/1440 layouts with zero page overflow or sub-44px enabled controls, keyboard skip/focus order, mobile drawer Escape/focus restoration, WCAG-AA token contrast, reduced motion, and 200% text. A real Codex approval remained operable at 200% text; decline created no target file. Timeline construction/windowing tests cover 100,000 items.
