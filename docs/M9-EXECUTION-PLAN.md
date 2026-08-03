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
- [ ] M9.9 bounded terminal/activity contract
- [ ] M9.10 security, recovery, fault, and performance gate
- [ ] M9.11 non-visual final gate and Grok handoff

## Checkpoint rule

Each slice updates this file, implementation status, and the handoff log; runs targeted tests plus the relevant package gate; checks the frozen-file diff; commits; and immediately proceeds. Full `pnpm check` runs at architecture-changing checkpoints and the final gate.

## Hard boundaries

- No edits to frozen Web visual files or Grok evidence/worktree.
- No merge/cherry-pick of Grok or Claude branches.
- No remote identity/ingress work.
- No unsupported provider control or invented telemetry.
- No prompt replay, unrestricted shell, raw project file endpoint, or weakened M8 guarantees.
