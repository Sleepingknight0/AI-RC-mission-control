# M9 Frontend Integration Gate

Date: 2026-08-03

Backend base: `edb07ee55cb3aa58aa064c5e8aff0f35236ad4a3`

Rebased Grok head: `4b2618b48d02600c754d212da15823b36dd3195b`

Codex integration heads: `bc53e83fda716be6ab9af56de4da9686773aa6ee`,
`d8527d7d04257c5a24c282aff00efb6c3016299d`

## Verdict

**PASS.** The complete rebased Grok frontend range is integrated with the final
M9 backend contracts. Both independent review axes pass after Codex remediation;
the normal combined gate, compiled-production browser acceptance, and unchanged
Real Codex E2E all pass. M9 frontend integration is unblocked and complete.

## Reviewed range and scope

The eight commits in `edb07ee..4b2618b` changed only:

- `apps/web/index.html`
- `apps/web/src/App.tsx`
- `apps/web/src/m9/state.ts`
- `apps/web/src/m9/ui.tsx`
- `apps/web/src/styles.css`
- `apps/web/test/m9-state.test.ts`

Codex reviewed the range on repository-Standards and M9-Spec axes. Initial
findings covered selected-Session authority fallback, cross-identity snapshots,
unvalidated MIME/conflict data, stale provider/native evidence, per-Turn
attachment accounting, unsupported sandbox/network options, Catalog metadata
gating, retry/error handling, motion/touch requirements, and browser evidence.
All demonstrated blockers were accepted and fixed; no assertion or protocol
boundary was weakened.

## Authority and lifecycle result

- Session control requires a matching current Catalog row, a matching fresh
  `session.capabilities.snapshot`, the current settings revision, and a ready
  binding. Missing, stale, unavailable, cross-Session, or unsupported evidence
  disables control.
- Native discovery and resume require the exact live provider/account snapshot.
  Settings, lease, capability, and attachment envelopes are identity-fenced.
- Fleet is used for inventory and create choices only. It cannot promote an
  existing Session to controllable.
- Catalog stale-cursor recovery discards the cursor and repeats only the
  read-only first-page query. Late request IDs are ignored. Search/project are
  debounced; categorical filters are immediate.
- Rename and pin use Core-owned metadata CAS independent of provider control;
  archive is disabled only while the Session runs.
- Attachment types are schema validated, local read/hash errors send nothing,
  correlation uses `commandId`, and the eight-slot bound counts the selected
  ready rows plus current uploads/begins for the next Turn.
- Sandbox/network settings remain visible but disabled until option-level
  Session capability support exists. No frontend support is invented.
- A missing clean-install placeholder Session releases only the replay lock for
  that exact selected identity, leaving the authenticated Core available for
  global Session creation. All Session controls still fail closed.

## Automated and production gate

```text
pnpm install --frozen-lockfile  PASS
pnpm migrate                    PASS (Core 13 / Connector 3; migrated=false)
pnpm migrate                    PASS (Core 13 / Connector 3; migrated=false)
pnpm build                      PASS
pnpm check                      PASS
git diff --check                PASS
```

`pnpm check` passed strict TypeScript, ESLint, production builds, 203 automated
tests, compiled production start/health/stop, online backup/verified restore,
restart/corrupt-backup rejection, clean-directory install, and private-Serve
automation. Test counts: Config 13, Protocol 33, Domain 4, Web 29, Connector 50,
Core 59, Host 15.

## Real Codex

The unchanged opt-in test passed on the integrated head:

```text
test/real-codex.e2e.test.ts: 1 passed
test body: 69.899 s
Vitest duration: 70.72 s
command wall: 72.221 s
```

It covers authoritative discovery/create/binding, streamed and final output,
concurrent-Turn rejection, interrupt, provider death to `outcome_unknown`, lost
Runtime rejection, fresh post-restart authority, generation-incremented native
resume without prompt replay, normalized-only events, and provider teardown.
The earlier Grok-host create failure did not reproduce in two unchanged runs of
the rebased code and final combined code; because the Grok range contained only
Web files, it is classified as transient provider/environment state rather than
a deterministic frontend regression.

## Browser acceptance

Playwright drove an isolated compiled-production instance, not a static mock.
Evidence under `output/playwright/m9-final-integration/` verified:

- 375×812, 768×1024, 1440×900, and 2560×1440 layouts;
- no horizontal overflow at each viewport;
- 200% root text with no horizontal overflow and the overview control fully
  visible;
- minimum visible button height of 44px at the mobile viewport;
- `prefers-reduced-motion: reduce` active;
- zero console errors and warnings;
- keyboard-visible focus and Escape restoration to the drawer trigger;
- refresh/rebootstrap with a fresh ticket and Core/Connector ready;
- empty-Catalog/missing-placeholder recovery to Core online without granting
  Session authority.

## Remaining risk

- `App.tsx` is still a large orchestration module. Review classifies this as a
  Low maintainability concern, not a demonstrated correctness/security defect.
- Product retention policy, M8.5 second-device evidence, and remote identity
  remain explicitly deferred outside this integration.
- `stash@{0}` and `grok/m9-ui-pre-edb07ee` remain untouched recovery evidence.
