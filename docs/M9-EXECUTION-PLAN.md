# M9 Non-Visual Execution Plan

## Baseline

- Main: `master` at `4ebd88d77a25e26245862259af5414e0a56c0bd4`
- Grok visual checkpoint: `grok/spacex-ui` at `c2f1d4813e80bf7d401424572c1fb890aa7a5e2b`
- Frozen visual files remain untouched; `stash@{0}` is preserved and obsolete.

## Milestones

- [x] M9.0 specifications, Web contract, and exact-head baseline
- [x] M9.1 provider capability Domain/protocol model
- [x] M9.2 Connector inventory reader, relay, Core snapshot, reconnect tests
- [x] M9.3 Session Catalog V2 database/protocol backend
- [x] M9.4 Codex discovery, create, resume, model/account capability control
- [x] M9.5 settings compare-and-set and effective Turn snapshots
- [x] M9.6 ask/plan/auto semantics
- [x] M9.7 server policy enforcement and scoped Full Auto leases
- [x] M9.8 managed attachment lifecycle and Codex translation
- [x] M9.9 bounded terminal/activity contract
- [x] M9.10 security, recovery, fault, and performance gate
- [x] M9.11 non-visual final gate and Grok handoff

M9.11 passed the unchanged Real Codex E2E after correcting the installed
account-probe interpretation with regression coverage. The original gate was
followed by Claude's independent audit as a post-M9 hardening gate.
Frontend-blocking authority, creation-bypass, catalog-revision, capability-
projection, authentication, concurrency, journal, and performance findings are
remediated at Core schema 13 / Connector schema 3. Independent post-fix Standards
and Spec reviews pass. The final local gate passed 185 automated tests and the
unchanged Real Codex E2E passed with a 71.228-second test body; exact evidence
is recorded in the remediation report.

## P1 integrated frontend closure

- [x] review the complete rebased Grok frontend range
- [x] consume `session.capabilities.snapshot` as selected-Session authority
- [x] fail closed for stale/cross-Session provider, native, settings, lease,
  attachment, and Catalog evidence
- [x] verify cursor recovery, filter throttling, per-Turn attachment accounting,
  metadata CAS controls, and migration/startup guidance
- [x] pass independent Standards and Spec re-reviews
- [x] pass compiled-production responsive/accessibility/refresh acceptance
- [x] pass the combined 203-test local gate and unchanged Real Codex E2E

The rebased frontend range `edb07ee..4b2618b` is integrated on `master` with
Codex hardening commits `bc53e83` and `d8527d7`. The final enabled provider run
passed with a 69.899-second test body (70.72-second Vitest duration; 72.221-second
command wall time). Detailed evidence is in
`reviews/codex/M9-FRONTEND-INTEGRATION-GATE.md`.

## Checkpoint rule

Each slice updates this file, implementation status, and the handoff log; runs targeted tests plus the relevant package gate; checks the frozen-file diff; commits; and immediately proceeds. Full `pnpm check` runs at architecture-changing checkpoints and the final gate.

## Hard boundaries

- Web edits require complete normalized-contract and browser verification.
- Grok and Claude evidence/worktrees remain read-only after integration.
- No remote identity/ingress work.
- No unsupported provider control or invented telemetry.
- No prompt replay, unrestricted shell, raw project file endpoint, or weakened M8 guarantees.
