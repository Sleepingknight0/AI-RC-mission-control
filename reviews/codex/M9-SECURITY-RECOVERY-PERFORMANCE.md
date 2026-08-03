# M9 Security, Recovery, Fault, and Performance Gate

Date: 2026-08-03

Scope: M9.10 non-visual backend

Baseline: `af7ee1fd2fc04c75f7cd52ef4240c96ea75680a3`

## Verdict

PASS. The targeted protocol, Connector, Core, and Host gate passed 82 tests.
No frozen Web file changed. Real-provider acceptance is reserved for M9.11 and
is not claimed by this checkpoint.

## Security and fault matrix

| Boundary | Evidence |
|---|---|
| Hostile Origin, missing capability, expired/replayed ticket, Core restart | `runtime-auth.test.ts`, `security-boundaries.test.ts` |
| Forged Connector, stale Runtime/generation, approval races | `security-boundaries.test.ts`, `approval-races.test.ts` |
| Malformed/duplicate/oversized provider inventory, ANSI, paths, secrets | `provider-capability.test.ts`, `provider-inventory.test.ts` |
| Provider timeout and sibling/Turn isolation | `provider-inventory-relay.test.ts` |
| Malformed/oversized Session queries, stale catalog/metadata/settings revisions | protocol and Core `session-catalog.test.ts`, `session-settings.test.ts` |
| Approval downgrade during a Turn, Full Auto replay/scope/restart/expiry | `session-settings.test.ts`, `approval-leases.test.ts`, `approval-policy.test.ts` |
| Traversal/junction escape and destructive Workspace Auto action | `approval-policy.test.ts`, protocol attachment tests |
| Incomplete, changed duplicate, corrupt, spoofed, expired, cross-device, cross-Session attachments | protocol/Core/Connector input-attachment tests |
| Core/Connector restart, provider death, uncertain outcome, no prompt replay | `durability-reconnect.test.ts`, `codex-adapter.test.ts` |
| Secret/path leakage, bounded terminal output and logs | provider, Codex adapter, terminal evidence, and Host logging tests |

All browser/provider payloads remain strict and bounded. Unknown or unsupported
capabilities fail closed; a failed inventory refresh revokes authority for a
new Session operation or Turn, while an already accepted Turn retains its
immutable settings and settles normally. Full Auto authority still requires the exact live Session settings,
device, provider, account, project, Runtime generation, lease revision, and Core
boot. Changing approval policy while a Turn executes returns `SESSION_BUSY`.

The post-audit schema-13 gate additionally proves that no pre-v13 write grant is
trusted without current explicit validation, Catalog `canControl` uses exact
per-Session authority, and every semantically rejected durable Connector event
commits its receipt and emits a stable structured diagnostic under a per-boot
bound. Duplicate approval evidence therefore cannot strand the FIFO journal.

## Scale and performance evidence

- A normalized 15-provider fleet validated in 5 ms in the verbose targeted run;
  the 65th provider is rejected by the 64-provider protocol ceiling.
- Connector parsed the real terminal registry without path leakage in 264 ms.
- Inventory timeout settled unavailable without blocking Turn completion in
  214 ms in the integrated Core/Connector test.
- The remediated SQLite catalog fixture contains 1,000 Sessions, 100 historical
  Turns, and 10 pending approvals. Its indexed first-page query remains capped
  at 250, unique, and deterministic with a 2-second query budget and less than
  256 MiB observed heap growth. Active Turn/timeline events no longer invalidate
  page two unless a catalog-visible value changes.
- The existing frozen Web state tests retain a bounded render window for a
  100,000-item timeline. This checkpoint did not modify or reformat them.
- Provider output, attachment allocation, WebSocket message rate, outstanding
  runtime tickets, inventory/accounts/models, Session page size, artifact
  allocation, and log generations all retain explicit ceilings.

Idle CPU and long-duration process memory are environment-sensitive operational
observations, not deterministic unit-test assertions. The compiled production
lifecycle/maintenance gate in M9.11 will start, health-check, exercise, and stop
the real process topology; a sustained soak remains an optional post-M9
operations test and is not represented as passed here.

## Commands

```text
pnpm --filter @aicl/protocol exec vitest run <M9 protocol suites> --reporter verbose
  18 passed
pnpm --filter @aicl/connector exec vitest run <inventory/input/Codex suites> --reporter verbose
  22 passed
pnpm --filter @aicl/core exec vitest run <auth/security/inventory/catalog/settings/approval/attachment/recovery suites> --reporter verbose
  39 passed
pnpm --filter @aicl/host exec vitest run test/logging.test.ts --reporter verbose
  3 passed
pnpm check
  build, typecheck, lint, 172 automated tests, lifecycle, maintenance,
  clean-install, and Tailscale automation passed; 1 opt-in Real Codex test skipped
git diff --check
  passed
```

## Limitations

- No claim is made for Google identity, Cloudflare, public ingress, or M8.5.
- Non-Codex providers remain inventory-only unless a future independently
  verified adapter proves control capability.
- The frozen Grok visual checkpoint has not yet consumed the M9 contracts.
- Real Codex and compiled production evidence must be rerun at the M9.11 exact
  head before the backend final verdict.
