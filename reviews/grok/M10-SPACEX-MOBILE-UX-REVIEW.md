# Grok M10 SpaceX Mobile UX Review

Date: 2026-08-04  
Branch: `grok/m10-spacex-mobile-polish`  
Base: `origin/codex/m10-mobile-account-session-shell` @ `2420d744813881803b2c89f6001804dc63300bc2`  
Role: Frontend-only visual and interaction polish (Grok)  
Authority: Codex retains architecture, protocol, backend, security, and merge control

## Scope

Frontend-owned paths only:

- `apps/web/src/**`
- `apps/web/test/**`
- `reviews/grok/**`

No Core/Connector/protocol/domain/migration changes.

## Claim

All reproducible UX/UI defects found within the approved M10 frontend scope were
resolved or documented.

## Bugs reproduced and fixed

| ID | Defect | Evidence | Resolution |
| --- | --- | --- | --- |
| B1 | Chat composer floated mid-screen when banners/approvals were absent | Mobile grid used six fixed rows; `1fr` track had no child | `mobile-chat-main` is flex column; timeline grows; composer is pinned |
| B2 | Global desktop CTA `text-transform: uppercase` forced all-caps on mobile natural language | Model names, session titles, status copy rendered as uppercase | `.mobile-chat-shell button` resets transform/letter-spacing |
| B3 | Model/Mode sheet repeated the same disabled reason on every choice | View-only sheet showed the blocker on each model/reasoning row | Shared section notice once; choices keep descriptions |
| B4 | Prompt-derived titles lost spaces after punctuation/newlines | Titles like `boundary.Do not use tools` | `displaySessionTitle()` normalizes newlines and `.!?` boundaries |
| B5 | Hidden file input leaked as “Choose File” in a11y tree | Snapshot listed native file control beside attachment trigger | `aria-hidden="true"` on file input |
| B6 | Account home was thin and dashboard-adjacent | Empty/home lacked chat-first hierarchy | Greeting/command panel, pinned section, incomplete-inventory notice |

## Bugs deferred / backend blockers

| Item | Why deferred |
| --- | --- |
| Titles like `STATEYou` without punctuation or newline | Stored catalog title has no separator; needs backend title generation |
| Full live multi-account polish with real Codex usage | Forbidden to consume remaining account usage for visual validation |
| Real streaming/approval visual states on mock inventory | Isolated mock runtime has no controllable Session inventory |

## Visual system

Original aerospace-grade shell (not a product clone):

- near-black void and graphite surfaces
- ice/cool-white accent, amber for attention, red for failure, restrained green for ready
- faint grid geometry and header rail
- flight-link status dots; pulse only for true running/working states
- reduced-motion disables drawer/sheet/pulse animations
- section labels may use uppercase; body/control copy does not

## Hierarchy preserved

Provider → Account → Session → Conversation remains authoritative.

- account-scoped search/list/pagination unchanged in contract
- no cross-account fallback introduced
- inventory-only providers remain non-controllable
- settings CAS still client-driven from existing App handlers

## Component architecture

Existing mobile decomposition retained and refined:

```text
apps/web/src/mobile/
  MobileChatShell.tsx
  MobileHeader.tsx
  MobileAccountHome.tsx
  MobileComposer.tsx
  ModelModeSheet.tsx
  AccountSessionDrawer.tsx
  ProviderAccountTree.tsx
  AccountSessionList.tsx
  MobileChatTimeline.tsx
  SystemStatusSheet.tsx
  SessionActionSheet.tsx
  MobileOverlay.tsx
  state.ts
```

Pure helpers:

- `displaySessionTitle`
- existing `groupAccountsByProvider`, `sessionsForProviderAccount`, `recentSessionsByPeriod`, etc.

## Test results

Web package:

```text
pnpm --filter @aicl/web typecheck  PASS
pnpm --filter @aicl/web lint       PASS
pnpm --filter @aicl/web test       66 passed
pnpm --filter @aicl/web build      PASS
```

Added regressions:

- title normalization
- flex composer pin / no forced uppercase
- aerospace token presence without neon excess
- shared model-sheet blocker de-duplication
- file input a11y hide

## Compiled production acceptance

Isolated mock runtime:

- config under `output/m10-spacex-polish-runtime/` (not shared LocalAppData DB)
- URL `http://127.0.0.1:8797/`
- provider `mock` (no real Codex Turns)

Viewports checked:

- 320×568, 360×800, 375×812, 390×844, 412×915, 430×932
- 768×1024, 1024×768, 1440×900, 1920×1080, 2560×1440

Results:

- horizontal overflow: none observed
- steady console errors: 0
- steady console warnings: 0
- mobile shell below 768px; desktop app shell above

Evidence (untracked local only):

```text
output/playwright/m10-spacex-mobile-polish/
```

## Accessibility

- Escape/focus restoration remains in `MobileOverlay`
- 44px minimum targets retained on mobile shell controls
- reduced-motion branch for mobile animations
- status buttons keep accessible labels
- file input hidden from AT

## Desktop

Desktop operational panels remain the default above 767px. No desktop redesign was performed beyond shared CSS safety.

## Unresolved backend-contract blockers

None required for the accepted frontend polish claim. Catalog title generation remains a backend concern if operators want perfect multi-line prompt titles.

## Final statement

Mobile is chat-first under 768px, with a restrained aerospace visual system, fixed composer layout, readable controls, and no intentional invariant regressions inside frontend scope.
