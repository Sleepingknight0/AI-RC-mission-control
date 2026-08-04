# M10 SpaceX Interface V2 — Final Codex Integration

## Verdict

- System: PASS
- Mobile UX: PASS after Codex repair
- Account and Session isolation: PASS
- Compiled-production browser acceptance: PASS
- Provider usage consumed: 0
- Real provider Turns submitted: 0

## Refs and lineage

| Ref | Verified SHA |
| --- | --- |
| Remote master before integration | `50e2d90e5bf9b2a5bccfd5f750da2ceb7919a5ce` |
| Codex M10 system branch | `2420d744813881803b2c89f6001804dc63300bc2` |
| Grok V1 | `739b53ae5134ebe479533a0d6d84c9f540f95be6` |
| Grok V2 | `3d1ef56f464c465ab0a3d2142db7a959f01f4aa9` |
| Codex integration repair | `93353740c161b947449228b9b8b440b8231b04ff` |

The M10 merge base was the exact M10 SHA. The verified left/right counts were
`0/9` for M10 to V2 and `0/4` for V1 to V2. The four V2 commits and their order
matched the handoff, and V2 was behind none of the three stated bases.

The V2-only scope contained exactly:

- `apps/web/src/mobile/MobileHeader.tsx`
- `apps/web/src/mobile/MobileAccountHome.tsx`
- `apps/web/src/mobile/MobileComposer.tsx`
- `apps/web/src/mobile/AccountSessionDrawer.tsx`
- `apps/web/src/styles.css`
- `apps/web/test/mobile-ui.test.ts`
- `apps/web/test/mobile-state.test.ts`
- `apps/web/test/mobile-overflow.test.ts`
- `reviews/grok/M10-SPACEX-INTERFACE-V2-LOOP.md`

No Core, Connector, Protocol, Domain, Config, Host, migration, or provider file
was changed by Grok. Codex reviewed the full M10-to-V2 frontend range, not V2 in
isolation.

## Codex repairs

Codex accepted the visual direction but repaired reproducible integration
defects before acceptance:

1. Derived the compact LINK/LIVE/HOLD/OFFLINE status from current Session
   authority as well as fleet/runtime health, so a stale or uncontrollable
   Session cannot appear healthy.
2. Removed duplicate rendering of pinned Sessions and added visible textual
   state, pinned, and archived labels so state is not color-only.
3. Preserved legitimate title punctuation and URLs while still normalizing
   line breaks and whitespace.
4. Made the native attachment input truly hidden and non-focusable, closed the
   attachment menu before picker invocation, and disabled the visible picker
   control immediately when connection/runtime/Session authority is absent.
5. Made overlay background siblings inert and restored their prior inert state,
   body scrolling, and trigger focus on closure.
6. Made the timeline keyboard-focusable for PageUp/PageDown/Home/End navigation.
7. Surfaced normalized settings conflicts in the Model and mode sheet without
   retrying or displaying the rejected value as applied.
8. Restored visible focus styling, raised the model/settings trigger to the
   44-pixel target, and fixed a Mobile grid selector that had turned the skip
   link into a layout row and allowed the header to cover Account Home actions.
9. Replaced source-string overflow assertions with an element-geometry issue
   classifier and added focused authority, title, file-input, conflict, pinned,
   and visible-state regressions.

The repair commit changes 14 Web source/test files only. Grok's nine commits
were preserved without squashing or rewriting.

## CSS and scroll review

Every changed Mobile CSS block was inspected for global leakage, duplicate
media rules, fixed viewport traps, unsafe overflow, missing flex/grid minimums,
safe-area duplication, transformed overlay ancestors, pointer interception,
z-index conflicts, horizontal overflow, reduced-motion gaps, focus removal, and
sub-44-pixel targets. The repair remained scoped to Mobile selectors except for
the existing generic focus-visible rule, which was broadened from only
`tabindex=-1` to all explicit tab stops.

Browser checks passed for `.mobile-timeline-scroll`, `.mobile-account-home`,
`.mobile-drawer-scroll`, `.mobile-sheet-scroll`, `.mobile-status-facts`, and
the bounded approval list. Mouse wheel, touch drag, PageUp/PageDown, Home/End,
focus auto-scroll, background isolation, and restoration were exercised. The
last Session, timeline item, sheet action, and approval action remained
reachable. A large code block scrolled locally without widening the page.

Drawer, Status, and Model overlays each passed ten rapid open/close cycles.
There was no residual overlay, body lock, inert state, or pointer interception.

## Accessibility and information discoverability

- File input: hidden, `tabIndex=-1`, `aria-hidden`, absent from tab order and
  accessibility exposure; the visible control has an exact label and authority
  reason. Fixture selection emitted only `attachment.upload.begin`, never a
  Turn, and cancellation left no menu overlay.
- Icon controls: accurate accessible names, visible focus, and 44-by-44 minimum
  hit areas. Send and Abort retain distinct iconography, names, and states.
- Overlays: focus trap, Escape closure, trigger focus restoration, inert
  background, and no focus behind the dialog passed.
- Status/details: Provider, Account, Session, Core, Connector, authentication,
  control, binding, Runtime, model, reasoning, execution mode, approval policy,
  pending approval, and stale/offline explanations remained discoverable in
  the shell or detailed sheets.
- Reduced motion: running, approval, and outcome-unknown remained understandable
  through text. No inspected element retained an animation or transition above
  0.02 seconds under `prefers-reduced-motion: reduce`.

## Compiled-production browser acceptance

Acceptance used `build/production`, never Vite, with normalized deterministic
fixtures for synthetic provider states. Fixture execution is not provider
execution.

All 17 viewports passed with zero page-width overflow, no actionable element
outside the viewport, no unintended element overflow, no header/composer
coverage, no hidden or `aria-hidden` focusable control, and no sub-44-pixel
action:

`320x568`, `360x640`, `360x800`, `375x667`, `375x812`, `390x844`, `412x915`,
`430x932`, `568x320`, `844x390`, `768x1024`, `820x1180`, `1024x768`,
`1366x768`, `1440x900`, `1920x1080`, and `2560x1440`.

The state matrix covered Account Home, drawer, long English/Thai Account labels,
long Session titles, zero/many/pinned/archived Sessions, active chat, long
timeline, large code, long model name, Model and Reasoning, System Status,
attachment, running, approval required, interrupted, outcome unknown, offline
Core, offline Connector, authentication required, inventory only, and settings
conflict. Offline Core was exercised through Chromium network isolation; its
deliberate connection failure was kept separate from steady-state console
evidence.

At real 200% browser text (`32px` root text), `320x568`, `390x844`, `430x932`,
`768x1024`, and `1366x768` passed with zero horizontal page overflow. The last
Session and sheet actions remained reachable, close controls remained visible,
the composer remained pinned and operable, and approval/offline states remained
operable. Intentional title ellipsis retains a full title/accessibility name.

With reduced motion enabled, the browser reported the media query active and
zero animations or transitions over 0.02 seconds. LIVE, approval, running, and
outcome-unknown states remained explicitly textual.

Steady compiled-fixture and real-inventory browser state both ended with:

- console errors: 0
- console warnings: 0
- unhandled page errors: 0
- unexpected failed requests: 0

## Account and Session authority

The existing M10 real-provider lifecycle and settings-CAS evidence was reused
because the reviewed range and Codex repair are frontend-only. No Real Codex E2E
was rerun.

Compiled-browser checks confirmed the Provider to Account to Session hierarchy,
three independent Codex account rows, account-scoped catalogs and search,
scoped draft restoration, fail-closed stale authority, no account-switch or
reconnect dispatch, and inventory-only presentation for unsupported providers.
A normalized conflict restored revision 7 authoritative values, displayed
`SESSION_SETTINGS_CONFLICT`, emitted one settings update, did not retry, and
submitted no Turn.

The operator's running production inventory was inspected read-only. Codex had
three stable account rows with 19, 8, and 18 visible scoped Sessions; each
account's deliberate no-match search returned zero rows. Claude, Grok, and
Antigravity remained visible in inventory. One existing Session, the Model,
Reasoning, execution-mode and approval-policy choices, and 14 populated System
Status facts were inspected. An unsent draft survived refresh, was never
dispatched, and was cleared afterward. Sanitized WebSocket-type instrumentation
recorded no `turn.submit`, Session creation, settings update, approval resolve,
account activation, or attachment upload.

## Automated gates

- `pnpm install --frozen-lockfile`: PASS
- `pnpm --filter @aicl/web typecheck`: PASS through the Web/full check
- `pnpm --filter @aicl/web lint`: PASS through the Web/full check
- `pnpm --filter @aicl/web test`: 78 passed
- `pnpm --filter @aicl/web build`: PASS
- `pnpm migrate` twice against the isolated M10 config: PASS, Core schema 14,
  Connector schema 3, `migrated: false` both times
- `pnpm build`: PASS
- `pnpm check`: PASS
- `git diff --check`: PASS

The Web count is 78 rather than Grok's reported 75 because Codex added three
regression tests. Repository total: 271 passed, 1 intentionally skipped. The
compiled production lifecycle, M8 maintenance/restore, clean-directory install,
and Tailscale automation gates also passed.

The default migration command was first attempted and safely refused because
the operator's production service was running. That service was not stopped;
the required two idempotency runs used the repository-supported isolated config.

## Evidence and limitations

Ignored local evidence is under
`output/playwright/m10-spacex-v2-final-integration/` and
`output/m10-spacex-v2-final-runtime/`. No screenshot, trace, database, raw log,
cookie, credential, account identity, runtime ticket, request header, provider
raw event, or authentication material is staged.

Known deferred issue: some stored catalog titles can concatenate semantic text
without a separator. The frontend now preserves legitimate punctuation instead
of guessing, but correcting already-generated titles belongs in backend title
generation and is outside this frontend-only integration.
