# M10 Mobile Account/Session Recovery Acceptance

Date: 2026-08-04  
Git base: `50e2d90e5bf9b2a5bccfd5f750da2ceb7919a5ce`  
Recovery branch: `codex/m10-mobile-account-session-shell`

## Verdict

- System: **PASS**
- Mobile UX: **PASS**
- Account isolation: **PASS**
- Configured Codex profiles: **3**
- Currently usable provider profiles: **1 of 3**
- Operator accounts with exhausted usage: **2** (operator-confirmed)
- No cross-account fallback: **PASS**
- Model/Reasoning CAS: **PASS**

## Recovery result

M10 was recovered as 13 local commits already owned by the current branch, with
HEAD `dce1363bca8519e80e12e8f9185787319d0d3aaf`. The working tree was initially
clean. `origin/master` remained at the expected base before and after fetch.
There was no active Git operation, detached M10 commit, alternate M10 worktree,
or remote M10 branch. The existing stash was preserved and never applied.

The first post-recovery exact-profile lifecycle did not pass: it reached first
and final output, concurrent-Turn rejection, interrupt, and provider death to
`outcome_unknown`, then timed out waiting for control after the new Runtime
generation. Diagnosis found that M10 deliberately requires a normal,
revision-fenced `session.runtime.resume`; the older lifecycle test still waited
for authority to return automatically. The test also looked for a Runtime field
that is intentionally absent from the normalized Session-capability snapshot.

The repaired acceptance flow now:

1. observes fresh capability evidence for the exact account;
2. submits `session.runtime.resume` with the current account revision and exact
   Runtime identity/generation;
3. verifies the durable ready binding in the new generation;
4. observes controllable normalized Session capabilities; and
5. verifies that no prior prompt or Turn was dispatched again.

The fast Core/Connector regression passes, and the exact real lifecycle passes
through deterministic teardown.

## Sanitized identity mapping

Operator accounts A and B are known to be exhausted from operator evidence, but
the repository does not prove which one individually maps to each of the two
rejected AICL profiles. That ambiguity is retained instead of inferred.

| Operator account | AICL accountId/profileId | Mapping confidence | Usage state |
| --- | --- | --- | --- |
| A | `bwcx-bluewhalex` or `not-bluewhalex` | unknown individually | exhausted |
| B | `bwcx-bluewhalex` or `not-bluewhalex` | unknown individually | exhausted |
| C | `easy-bluewhalex` | proven by current sanitized account environment plus exact registry/config identity | available |

| Provider | Sanitized accountId | Authentication evidence | Freshness/control | Test status |
| --- | --- | --- | --- | --- |
| Codex | `bwcx-bluewhalex` | configured; no credential content read | no current control granted | prior checkpoint reports `PROVIDER_REJECTED` before first delta; not reprobed |
| Codex | `not-bluewhalex` | normalized provider evidence | no current control granted | exact Turn rejected with `PROVIDER_REJECTED` before first delta |
| Codex | `easy-bluewhalex` | authenticated normalized evidence | live `remote_control` | complete lifecycle PASS |

Profile selection resolves one stable registry `profile.id`, then supplies the
repository-supported `AICL_CODEX_PROFILE` and that profile's own `CODEX_HOME`.
The real test now aborts if that exact ID is absent from inventory. It does not
select by list position, directory fallback, default account, credential copy,
or retry on another profile.

## Mobile and account isolation

The compiled-production artifact at source commit `dce1363bca85` remains valid
because the recovery remediation changed lifecycle tests only. Its sanitized
result covers 320×568, 360×800, 375×812, 390×844, 412×915, 430×932, and
768×1024 with no horizontal overflow or undersized visible targets. It also
passes 200% text, reduced motion, drawer/model-sheet Escape and focus
restoration, and a stable console with 0 errors and 0 warnings.

The browser and automated evidence proves:

- Sessions are keyed and filtered by provider plus exact account.
- Identical provider-native Session IDs under different accounts stay distinct.
- Search and cursor pagination do not cross account boundaries.
- Drafts remain scoped to the exact Account and Session.
- Cross-account deep links clear the foreign Session and fail closed.
- Account switching and reconnect restore state without dispatching a prompt.
- A rejected account never activates or falls back to a different account.
- Model/capability state is account-scoped.
- Claude, Grok, and Antigravity remain inventory-only.

The live account contained 18 Sessions and no next page, so large live
pagination was not manufactured. Exact-account lookup at 1,000 Sessions, the
350-Session Web selector, cursor append/deduplication, and stale-cursor recovery
are covered by automated tests.

## Model and Reasoning CAS

Two independent browser contexts first observed the same isolated, bound,
ready Session at settings revision 3 with fresh capabilities for
`easy-bluewhalex`. Supported evidence advertised model `gpt-5.6-sol` and the
reasoning values used by the test; no model or reasoning option was fabricated.

- Browser A changed reasoning from `high` to `medium` with expected revision 3.
  Core accepted revision 4 and both contexts received matching authoritative
  settings and capability snapshots.
- Browser B submitted `low` with stale expected revision 3. Core rejected it as
  `SESSION_SETTINGS_CONFLICT`, returned revision 4 and the authoritative
  settings, performed no automatic retry, and never displayed or dispatched the
  rejected value.
- A bounded Turn used settings revision 4 and completed with immutable effective
  model `gpt-5.6-sol` and reasoning `medium`. The stale command had zero dispatch
  attempts.

One initial A update was truthfully rejected as
`PROVIDER_ACCOUNT_UNAVAILABLE` after its capability evidence expired. The exact
account was refreshed; no settings or Turn were applied by that rejected
command.

## Verification

```text
Core restart regression             PASS (6 tests; new case 0.762–0.783 s)
Account-isolation targeted matrix   PASS (121 tests)
Exact Real Codex lifecycle          PASS (79.84 s body; 80.76 s Vitest)
pnpm install --frozen-lockfile      PASS
pnpm migrate                        PASS (Core 13 / Connector 3)
pnpm migrate                        PASS (idempotent repeat)
pnpm build                          PASS
pnpm check                          PASS (253 automated tests; 1 opt-in skip)
git diff --check                    PASS
```

The final check includes strict typecheck, ESLint, all production builds, the
compiled production lifecycle, backup/restore/migration/corruption coverage, a
clean-directory production install, and Tailscale automation. The opt-in real
provider test was run separately against the exact available profile and
passed. Raw logs, screenshots, traces, databases, tickets, headers, account
details, and authentication material are ignored and excluded from Git.

## Remaining limitations

- The individual A/B operator-to-profile mapping remains unknown; only their
  exhausted state and the two rejected profile IDs are retained.
- The `bwcx-bluewhalex` rejection is supported by the recovered checkpoint, not
  a newly consumed provider probe. It was deliberately not rerun.
- M8.5 real second-device acceptance, Google/Cloudflare identity, and the
  general durable-retention policy remain deferred.

## Observable demo

Run `pnpm start`, open the same-origin production URL, select the exact Codex
account, and use the Account → Session hierarchy. Search, drafts, deep-link
rejection, native resume, settings CAS, reconnect, and explicit Runtime resume
operate through normalized Core authority; no prompt is dispatched by account
or reconnect navigation.
