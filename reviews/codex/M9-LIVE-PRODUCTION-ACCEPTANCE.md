# M9 Live Production Acceptance

## Gate identity

- Baseline SHA: `3232e546837dbe1e124eaeee6970bb6acd206aeb`
- Remediation implementation commit: `85ae1cfd7dde78fdf1e51eaae267ccc50b70cb5f`
- Test date: 2026-08-04 (Asia/Bangkok)
- Production URL: `http://127.0.0.1:8787`
- Local evidence: `output/playwright/live-production-acceptance/20260803-235335/`

The acceptance used the compiled production Web build, real Core and Connector
processes, the currently authenticated real Codex account, a clean headed
Chromium context controlled through Playwright, and normal same-origin HTTP and
WebSocket paths. No provider mocks, injected Session state, or direct protocol
commands substituted for browser interaction. Account identity, credentials,
runtime tickets, and request headers are not recorded in this report.

## Live results

- Bootstrap passed. Core reached online, Connector reached ready, provider
  inventory and Catalog reached ready, and the browser obtained a fresh runtime
  ticket without dispatching a command. Initial replay completed in 283 ms; the
  final repaired-build bootstrap completed in 872 ms.
- A separate fresh production database with zero Catalog rows reached ready,
  showed 0 of 0 Sessions, did not remain locked on the absent `session-demo`,
  and enabled New Session once fresh provider authority was available.
- Real Session create passed for `live-web-fixed-20260803-235335` in the isolated
  disposable project. Provider binding became ready and the authoritative
  Catalog and `session.capabilities.snapshot` made the Session controllable in
  1,212 ms without relying on fleet authority alone.
- The read-only Turn inspected `README.md`, displayed its first streaming delta
  in 2.355 seconds, completed in 12.126 seconds, rendered only normalized
  activity, and survived refresh.
- The controlled write passed through a visible Web approval. The normalized
  command completed, Diff Review displayed the change, and
  `live-web-fixed-proof.txt` contained exactly `AI-RC LIVE WEB FIXED PASS`.
  Provider write evidence remained inside the isolated project.
- Abort interrupted a real bounded Turn after five seconds. The Session became
  `INTERRUPTED`, returned to an operable state, and did not replay the prompt.
- Refresh obtained a new runtime ticket, replayed durable state, restored the
  Session and timeline, retained an unsent local draft, and did not dispatch it.
- Two 11-byte text attachments with the same filename and different contents
  returned `ALPHA-0001` and `BRAVO-0002` in the correct order. Unsupported SVG
  was rejected, a removable upload released its slot, referenced attachments
  were not deletable, and Session switching did not transfer pending bytes.
- Authority failed closed for inventory-only providers, missing or stale
  Session projections, non-ready binding, unsupported attachments, Connector
  loss, and a real Codex process launched with a newly created empty Codex home.
  The empty home reported not-authenticated inventory-only evidence and
  withdrew Session creation and launch without copying or changing credentials.
- Search and project filters were debounced; provider, account, archive, pin,
  and state filters were immediate; superseded responses did not replace newer
  results; metadata mutations were not retried automatically.
- Compiled production passed at 375x812, 390x844, 768x1024, 1024x768,
  1440x900, 1920x1080, and 2560x1440. There was no horizontal overflow; 20/20
  sampled keyboard stops had visible focus; Escape restored drawer focus; 200%
  text retained controls; reduced motion disabled animation; and required
  interactive targets measured at least 44 px after remediation. A final stable
  browser context emitted zero console errors and zero warnings.

## Reproduced defects and remediation

1. Chromium rejected the Session ID HTML `pattern` under Unicode Sets (`v`)
   semantics because the character-class hyphen was unescaped. The pattern now
   escapes the hyphen, and `apps/web/test/m9-ui.test.ts` compiles and exercises
   the emitted browser pattern.
2. A provider-binding transition changed the visible Catalog row but retained a
   stale cursor and stale `canControl`. The reducer now discards the cursor and
   requests an authoritative first page without fabricating control.
   `apps/web/test/m9-state.test.ts` preserves that invariant.
3. A settings mutation sent the updated settings snapshot only to its requester
   while broadcasting the matching capability revision. Core now broadcasts
   the settings snapshot to all subscribers and directly serves an unsubscribed
   requester. `apps/core/test/session-lifecycle.test.ts` covers two browsers
   receiving matching settings and capability revision 1.
4. Compact Pin controls measured 43.34 px at narrow widths. `.text-button` now
   has a 44 px minimum width, with source-level coverage in
   `apps/web/test/m9-ui.test.ts` and a repeated compiled-browser measurement.

Each regression was observed failing on the baseline behavior and passing with
the remediation. The changes do not loosen protocol validation, provider or
Session authority, authentication, approval, attachment containment, migration,
or Runtime fencing.

## Final verification

```text
pnpm install --frozen-lockfile  PASS
pnpm migrate                    PASS (Core 13 / Connector 3; migrated=false)
pnpm migrate                    PASS (Core 13 / Connector 3; migrated=false)
pnpm build                      PASS
pnpm check                      PASS (207 automated tests; 1 opt-in skip)
git diff --check                PASS
Real Codex E2E                  PASS (75.111 s body; 75.97 s Vitest)
```

The ordinary test count is Config 13, Protocol 33, Domain 4, Web 32,
Connector 50, Core 60, and Host 15. Compiled production lifecycle,
maintenance/restore, clean-install, and Tailscale automation gates also passed.

## Known deferred work

- The authentic Catalog held only five Sessions, so a live page-two cursor could
  not be produced without fabricating or mass-creating provider Sessions. Active
  pagination, invalid/stale cursor recovery, and catalog-visible revision
  invalidation remain covered by Core, protocol, and Web state tests.
- General durable retention remains the accepted bounded Medium policy gap.
- M8.5 second-device acceptance and the Google/Cloudflare identity boundary
  remain deferred by the operator.
- Local screenshots, trace, network log, console log, disposable databases, and
  acceptance project are evidence only and are intentionally not tracked.
