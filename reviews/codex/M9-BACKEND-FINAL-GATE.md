# M9 Non-Visual Backend Final Gate

Date: 2026-08-03

M9.11 completion baseline: `b6cd01576ed0f817cc07ea7735dfc1ce86305c9d`

Post-independent-review implementation head: `708e6237e112cf4581c2356e3d70f8b669d7fee4`

## Verdict

**PASS.** M9.0–M9.11 remain complete, and every accepted frontend-blocking or
High/security Claude finding is remediated. The unchanged Real Codex E2E passed
on the authenticated account, and the frozen-install, schema, build, automated,
production-lifecycle, maintenance, clean-install, and diff gates all pass.

Core is schema 13 and Connector is schema 3. Both migration ledgers remain
checksummed. The frozen Web was not modified or integrated during remediation.

## Real Codex result

The exact opt-in test passed without weakened assertions:

```text
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
  1 passed
  test body: 71.228 s
  Vitest duration: 72.16 s
  command wall time: 76.4 s
```

It proved authoritative provider/account/capability discovery, explicit Session
creation and binding, first assistant delta and authoritative final output,
`TURN_ALREADY_ACTIVE`, interrupt, provider kill to `outcome_unknown`, lost-
Runtime rejection, fresh authority after provider restart, a generation-
incremented new-process resume, no replay of the ambiguous command, no raw
provider-event leakage, and deterministic teardown.

## Provider incompatibilities found and fixed

The first M9.11 runs on the new account failed safely before first delta as
`turn.failed:PROVIDER_REJECTED`. This was not a quota failure: login status, a
minimal read-only Codex turn, and a direct app-server Turn all succeeded. The
capability probe had incorrectly treated `requiresOpenaiAuth: true` as missing
login despite a present ChatGPT account.

Authentication now uses the installed schema's nullish account field: only a
valid present account plus a fresh successful probe grants authority. Null,
omitted, malformed, logged-out, failed, and stale probe states fail closed.
Regression tests cover these installed shapes without assigning unmeasured
semantics to the mode flag. No credential, email, plan, token, provider payload,
or raw trace was persisted or exposed.

The remediated gate also exposed a lifecycle incompatibility that unit mocks had
hidden: `thread/resume` immediately after `thread/start` on the same live app-
server can fail with `no rollout found`. The adapter now reuses process-local
prepared threads without a redundant resume RPC, while a new provider process
still performs the required resume. A fake-provider regression rejects redundant
resume and proves the Turn executes once.

## Authoritative local gate

```text
pnpm install --frozen-lockfile  PASS (lockfile unchanged)
pnpm migrate                    PASS (Core 12→13, Connector 3, verified backup)
pnpm migrate                    PASS (Core 13, Connector 3, no change)
pnpm build                      PASS (compiled production + Web build)
pnpm check                      PASS
git diff --check                PASS
```

`pnpm check` passed strict TypeScript, ESLint, production builds, 185 automated
tests, compiled production start/health/stop, online backup, verified restore,
restart, corrupt-backup rejection, clean-directory compiled install, and the
private-Serve automation smoke. The ordinary suite correctly reported the
opt-in Real Codex test skipped; the explicit enabled run above passed.

The 185 tests comprise Config 13, Protocol 33, Domain 4, frozen Web 11,
Connector 50, Core 59, and Host 15. The no-test fixture package exited zero and
is not counted.

## Audit security and recovery evidence

- Exact-Origin one-time browser tickets reject expiry, replay, hostile origins,
  and Core restart reuse.
- Connector/boot/Runtime identity, Session/settings/approval revisions, and one
  executing Turn remain fenced.
- Full Auto authority remains device/provider/account/project/Runtime scoped,
  expiring, audited, revocable, restart-invalidated, and emergency-stoppable.
- Managed attachments remain opaque, bounded, Session/device owned,
  checksummed, MIME/magic verified, single-use, and path-contained.
- Provider loss and ambiguous side effects converge to `outcome_unknown`; no
  prompt is replayed.
- Legacy/unconfigured/null-project Sessions default to read-only/network-denied
  and are not controllable; schema 13 also revokes every unproven pre-v13 write
  grant. `turn.submit` never creates or fabricates authority.
- Catalog cursors survive ordinary timeline events and become stale only on
  ordering/filter-visible changes.
- `session.capabilities.snapshot` is the authoritative per-Session projection
  for provider/account/model, control, execution, attachment, approval, lease,
  unsupported reasons, and freshness.
- Provider/session/output/log data remains bounded and redacted. Non-Codex
  providers remain inventory-only.
- Catalog `canControl` uses the same per-Session validator as Turn submission;
  invalid durable Connector evidence commits its receipt and is acknowledged
  only with a stable, structured, boot-bounded diagnostic.

Detailed evidence remains in `M9-SECURITY-RECOVERY-PERFORMANCE.md` and
`M9-CLAUDE-AUDIT-REMEDIATION.md`.

Independent post-fix Standards and Spec reviews both passed. The reviewers
confirmed all accepted High/security findings closed and no new scope
regression. Two Low maintainability judgments remain (capability projection
module size and policy scattering); neither has a demonstrated security or
behavior effect and neither blocks the frontend integration review.

## Historical frozen Web and Grok handoff (completed below)

The frozen main-worktree visual files remain byte-for-byte equal to the audit
baseline. The preserved visual checkpoint is commit
`c2f1d4813e80bf7d401424572c1fb890aa7a5e2b`. The isolated review branch is
`origin/grok/m9-frontend-integration` at
`8d792cdd0fd688bf547bca28bc97aa8eb7455312`, based on pre-remediation
`b6cd01576ed0f817cc07ea7735dfc1ce86305c9d`. Its six frontend-only commits were
not modified or integrated by this gate, and `stash@{0}` remains unapplied.

Integration sequence:

1. Confirm final pushed `master`, the Grok worktree, and the preserved stash are
   clean; do not merge or cherry-pick the current branch.
2. Rebase `grok/m9-frontend-integration` at `8d792cd` onto the final remediation
   SHA, then update the remote only with `--force-with-lease` after checking the
   rewritten range.
3. Replace provider-fleet authority gating with the selected Session's
   `session.capabilities.snapshot`; retained/stale auth evidence must never keep
   create/resume/Turn/attachment/settings/approval/lease controls enabled.
4. Adapt catalog pagination to the catalog-visible revision contract and recover
   a genuinely stale cursor by restarting the query without duplicating rows.
5. Review duplicate same-name/same-size attachments and count accounting,
   search/project-filter request throttling, and migration-checksum recovery
   guidance.
6. Run Web typecheck/tests/build, responsive/accessibility browser acceptance,
   `pnpm check`, and unchanged Real Codex E2E; review the complete rebased commit
   range and merge only after the combined gate passes.

## Known limitations and exclusions

- At this backend-only gate, the Grok frontend branch still targeted the old
  contracts; its remediation rebase/adaptation and combined review were
  pending. The integrated follow-up below closes that work.
- General durable command/event/artifact/approval-audit retention remains a
  bounded Medium policy gap. Defining deletion without retention duration,
  export, replay-floor, legal-hold, and audit-preservation rules would weaken
  safety; current risk is long-term database growth, not added authority.
- M8.5 second-device acceptance remains operator-deferred.
- Google identity, Cloudflare, Tailscale redesign, remote identity, non-Codex
  control adapters, and sustained soak testing remain outside M9.

## Integrated frontend follow-up

The backend handoff was subsequently consumed by the rebased Grok frontend
range `edb07ee..4b2618b`. Codex independently reviewed the complete range,
integrated it, and closed authority, snapshot-fencing, attachment, Catalog,
startup-recovery, accessibility, and clean-install replay findings in
`bc53e83` and `d8527d7`.

The combined gate passes Core schema 13 / Connector schema 3, 203 automated
tests, all compiled lifecycle and maintenance checks, responsive/accessibility
Playwright acceptance, and the unchanged Real Codex E2E (69.899-second test
body). The former frozen-Web handoff steps above are retained as historical
evidence and are no longer pending. See `M9-FRONTEND-INTEGRATION-GATE.md`.
