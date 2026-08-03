# M9 Non-Visual Backend Final Gate

Date: 2026-08-03

Baseline: `master` at `01db53aedbf6ad01cb2c6db82d2cde7b2a356315`

## Verdict

**PASS.** M9.0–M9.11 are complete. The unchanged Real Codex E2E passed on the
new authenticated account, and the frozen-install, schema, build, automated,
production-lifecycle, maintenance, clean-install, and diff gates all pass.

Core is schema 11 and Connector is schema 3. Both migration ledgers remain
checksummed. The frozen Web was not modified or integrated during M9.

## Real Codex result

The exact opt-in test passed without weakened assertions:

```text
pnpm --filter @aicl/core exec vitest run test/real-codex.e2e.test.ts --reporter verbose
  1 passed
  test body: 70.499 s
  Vitest duration: 71.49 s
  command wall time: 73.270 s
```

It proved first assistant delta and authoritative final output,
`TURN_ALREADY_ACTIVE`, interrupt, provider kill to `outcome_unknown`, lost-
Runtime rejection, a generation-incremented new-process resume, no replay of the
ambiguous command, no raw provider-event leakage, and deterministic teardown.

## Account-probe incompatibility found and fixed

The first unchanged runs on the new account failed safely before first delta as
`turn.failed:PROVIDER_REJECTED`. This was not a quota failure:

- `codex-cli 0.146.0` reported an authenticated ChatGPT login under the selected
  `CODEX_HOME`;
- a minimal read-only `codex exec` returned the expected answer;
- a direct app-server probe using AICL's RPC launcher and exact thread request
  completed successfully;
- AICL's capability probe alone reported unauthenticated.

Measured `account/read` behavior showed a non-null `chatgpt` account together
with `requiresOpenaiAuth: true`, followed by successful real Turns. AICL had
incorrectly treated that mode flag as missing-login state. Authentication now
uses the installed schema's nullable account presence while still validating
the flag. `codex-discovery.test.ts` locks down this exact response shape; the
new test failed before the fix and passed after it. No credential, email, plan,
token, provider payload, or raw trace was persisted or exposed.

## Authoritative local gate

```text
pnpm install --frozen-lockfile  PASS (lockfile unchanged)
pnpm migrate                    PASS (Core 11, Connector 3, no change)
pnpm migrate                    PASS (Core 11, Connector 3, no change)
pnpm build                      PASS (compiled production + Web build)
pnpm check                      PASS
git diff --check                PASS
```

`pnpm check` passed strict TypeScript, ESLint, production builds, 173 automated
tests, compiled production start/health/stop, online backup, verified restore,
restart, corrupt-backup rejection, clean-directory compiled install, and the
private-Serve automation smoke. The ordinary suite correctly reported the
opt-in Real Codex test skipped; the explicit enabled run above passed.

The 173 tests comprise Config 13, Protocol 32, Domain 4, frozen Web 11,
Connector 45, Core 53, and Host 15. The no-test fixture package exited zero and
is not counted.

## Security and recovery evidence

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
- Provider/session/output/log data remains bounded and redacted. Non-Codex
  providers remain inventory-only.

Detailed evidence remains in `M9-SECURITY-RECOVERY-PERFORMANCE.md`.

## Frozen Web and Grok handoff

The frozen main-worktree visual files remain byte-for-byte equal to the M9
baseline. The preserved visual checkpoint is commit
`c2f1d4813e80bf7d401424572c1fb890aa7a5e2b`. The clean Grok branch is currently
at `a1623ba956416b80eac48dddd33c85b2fb404afa`; its first commit `2736805` is the
rebased checkpoint with the same stable patch ID and byte-identical Web visual
tree, followed by three isolated M9 frontend commits. The branch was not
modified or integrated by this gate, and `stash@{0}` remains unapplied.

Integration sequence:

1. Confirm final `master`, the Grok worktree, and the preserved stash are clean.
2. Rebase the current clean `grok/spacex-ui` branch at `a1623ba` onto final
   `master`; do not merge/cherry-pick `c2f1d48` again and do not apply
   `stash@{0}`.
3. Implement every reducer/command path in
   `docs/M9-WEB-INTEGRATION-CONTRACT.md`, keeping provider/model/account/policy
   data capability-driven and drafts/attachments scoped per Session/device.
4. Preserve Core validation, revision fences, approval boundaries, no-replay
   semantics, and normalized-only Web data.
5. Run Web typecheck/test/build, responsive/accessibility/browser acceptance,
   the complete repository gate, and the Real Codex E2E before merging.

## Known limitations and exclusions

- Grok frontend integration and visual acceptance have not begun.
- M8.5 second-device acceptance remains operator-deferred.
- Google identity, Cloudflare, Tailscale redesign, remote identity, non-Codex
  control adapters, and sustained soak testing remain outside M9.
