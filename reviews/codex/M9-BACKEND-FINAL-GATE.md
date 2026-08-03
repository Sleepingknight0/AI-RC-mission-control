# M9 Non-Visual Backend Final Gate

Date: 2026-08-03

Implementation under test: `69c9b83ccc5e2427df222023c9402845f288255f`

Branch: `master`

## Verdict

**EXTERNALLY BLOCKED.** All local non-visual M9 implementation, schema,
security, recovery, production, maintenance, and clean-install gates pass. The
required exact-head Real Codex E2E cannot pass while the active Codex workspace
has no credits. This result is not represented as a code pass or a skipped pass.

## Completed scope

M9.0–M9.10 are implemented and committed: specifications, truthful provider
capabilities and inventory relay, Catalog V2, verified Codex discovery/create/
resume, settings CAS, ask/plan/auto, Core approval policies and leases, managed
attachments, terminal evidence, and security/recovery/scale coverage. Core is
schema 11; Connector remains schema 3. Both migration ledgers are checksummed.

## Authoritative local gate

```text
pnpm install --frozen-lockfile  PASS (lockfile unchanged)
pnpm migrate                    PASS (Core 11, Connector 3, no change)
pnpm migrate                    PASS (Core 11, Connector 3, no change)
pnpm build                      PASS (compiled production + Web build)
pnpm check                      PASS
git diff --check                PASS
```

`pnpm check` passed strict typecheck, ESLint, production builds, 172 automated
tests, compiled production start/health/stop, online backup, verified restore,
restart, corrupt-backup rejection, clean-directory compiled install, and the
existing private-Serve automation smoke. The ordinary suite reported one
opt-in Real Codex test skipped. The production supervisor was stopped cleanly
after the gate; `pnpm status` reported supervisor/Core/Connector offline and
`pnpm doctor` exited zero.

The 172 passed tests comprise Config 13, Protocol 32, Domain 4, frozen Web 11,
Connector 44, Core 53, and Host 15. The no-test fixture package exited zero and
is not counted.

## Real Codex result

The opt-in test was explicitly enabled after the local gate. Two unchanged
runs reached `command.accepted`, `turn.started`, and active-Turn rejection, but
then received `turn.failed` before any assistant delta and timed out under the
old diagnostic. A third instrumented run failed immediately and safely as:

```text
Real Codex Turn ended before first delta: turn.failed:PROVIDER_REJECTED
```

An independent direct `codex app-server --stdio` spike using the installed
0.146.0 binary reproduced the same failed Turn outside AICL. Its normalized raw
terminal error was `usageLimitExceeded` with the provider reporting that the
workspace is out of credits. The direct compatibility probe still passed with
the canonical schema fingerprint and no missing methods. This falsifies an M9
Core/Connector dispatch regression and establishes an external quota blocker.
The diagnostic artifact is intentionally outside the repository at
`C:\Temp\aicl-m9-real-codex-probe`; it contains provider traces and must not be
committed or exposed.

The Real Codex harness now fails fast when a Turn becomes failed, interrupted,
or unknown before first delta and emits only normalized event types, failure
codes, Runtime state, and opaque Turn IDs. It does not log prompts, credentials,
provider payloads, or raw errors.

## Security and recovery evidence

- Exact-Origin one-time browser tickets reject expiry, replay, hostile origins,
  and Core restart reuse.
- Connector/boot/Runtime identity, Session/settings/approval revisions, and one
  executing Turn remain fenced.
- Full Auto authority is device/provider/account/project/Runtime scoped,
  expiring, audited, revocable, restart-invalidated, and emergency-stoppable.
- Attachments are opaque, bounded, Session/device owned, checksummed, MIME/magic
  verified, single-use, and rejected across Sessions or unsafe paths.
- Provider loss and ambiguous side effects converge to `outcome_unknown`; no
  prompt is replayed.
- Provider/session/output/log data is bounded and redacted. Non-Codex providers
  remain inventory-only.

Detailed evidence is in `M9-SECURITY-RECOVERY-PERFORMANCE.md`.

## Frozen Web and Grok handoff

No frozen visual file changed. The preserved visual checkpoint remains:

```text
C:\Projects\AI-RC-mission-control-grok
grok/spacex-ui
c2f1d4813e80bf7d401424572c1fb890aa7a5e2b
```

After credits are restored and this exact-head Real Codex test passes, integrate
from clean branches only:

1. Confirm main, Grok worktree, and preserved stash are clean/unchanged.
2. In the Grok worktree, rebase `grok/spacex-ui` onto the final local `master`;
   do not apply `stash@{0}`.
3. Add reducer/command integration for every envelope in
   `docs/M9-WEB-INTEGRATION-CONTRACT.md`. Keep provider/model/account/policy data
   capability-driven and keep drafts/attachments scoped per Session/device.
4. Preserve the Grok visual checkpoint while resolving only deliberate contract
   conflicts. Do not weaken Core validation or approval boundaries.
5. Run Web typecheck/test/build, responsive/accessibility/browser acceptance,
   the complete repository gate, and Real Codex acceptance before merge.

## Remaining blockers and exclusions

- Required: restore Codex workspace credits and rerun the exact-head Real Codex
  E2E. No code or credential change is authorized as a workaround.
- Frozen: Grok frontend integration and visual acceptance.
- Deferred outside M9: M8.5 second-device acceptance, Google identity,
  Cloudflare, Tailscale redesign, and remote identity.
- Optional after a passing integrated checkpoint: sustained idle CPU/memory soak
  and independent review.
