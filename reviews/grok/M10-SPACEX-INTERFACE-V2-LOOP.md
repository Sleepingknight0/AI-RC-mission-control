# M10 SpaceX Interface V2 — Engineering Loop Ledger

Branch: `grok/m10-spacex-interface-v2`  
V1 base: `739b53ae5134ebe479533a0d6d84c9f540f95be6`  
Portfolio reference: `C:\Projects\bluewhalex-portfolio-v05-reference` (read-only)

## Portfolio grammar extracted

From `index.html` CSS custom properties and chrome:

- pure black void (`#000`), bone text (`#F5F5F5`), mist/mute grays
- white signal accent; thin translucent lines
- mono metadata + technical uppercase labels (not body paragraphs)
- 44px touch targets; safe-area insets
- focus-visible 2px white outline
- reduced-motion support
- full-width flight bar; text links over pill clutter
- corner framing / restrained glow only for live state

Mission Control does **not** copy Portfolio wordmark, personal content, or Google font CDN (system stacks only per product constraint).

## Scroll containers (after V2)

| Container | Purpose |
| --- | --- |
| `.mobile-timeline-scroll` | Primary conversation scroll |
| `.mobile-account-home` | Account home list scroll |
| `.mobile-drawer-scroll` | Drawer inventory scroll |
| `.mobile-sheet-scroll` | Sheet content scroll |
| `.mobile-approval-list` | Bounded approval strip (when present) |

Shell body and `.mobile-chat-shell` remain `overflow: hidden`.

## Defect ledger

### V2-H1 — Composer mid-screen / empty 1fr track
- **Severity:** High
- **Viewport:** 390×844
- **State:** Chat with no banners
- **Root cause:** V1 used fragile multi-row grid; V2 keeps flex column + `min-height: 0`
- **Fix:** Confirmed flex pin + timeline flex-grow + scroll-padding
- **Verification:** CSS contracts + layout inspection

### V2-H2 — Visual density / card nesting / dual status pills
- **Severity:** High (usability)
- **Root cause:** Hero command card + large marks + two-line status chip + ice glow palette
- **Fix:** Removed command card and decorative grid; compact header identity; single LINK control; monochrome tokens; square frames
- **Verification:** Header renders `LINK` not dual Connected/Ready pills

### V2-H3 — Forced uppercase / blue glow clutter
- **Severity:** Medium
- **Fix:** Mobile buttons `text-transform: none`; monochrome signal; no permanent card glow
- **Verification:** Token tests reject neon/rainbow

### V2-H4 — Nested overlay scroll height broken
- **Severity:** High
- **Root cause:** Sheet/drawer panels lacked flex column + `min-height: 0` on scroll regions
- **Fix:** Panel is flex column; heading flex 0; scroll region flex 1; max sheet height 78dvh; drawer `min(88vw, 360px)`
- **Verification:** overflow CSS contracts

### V2-M1 — Long code / path horizontal expansion
- **Severity:** Medium
- **Fix:** timeline `overflow-x: hidden`; `pre/code` local `overflow-x: auto`; `overflow-wrap: anywhere`
- **Verification:** overflow tests

### V2-M2 — File input a11y leak
- **Severity:** Medium
- **Fix:** retained `aria-hidden` + `tabIndex={-1}`
- **Verification:** unit test

### V2-M3 — Fixture clock fragility in web tests
- **Severity:** Medium (test)
- **Root cause:** live `staleAt` expired vs real `Date.now()`
- **Fix:** fixed `now` in selectors tests; far-future `staleAt` for UI fixtures
- **Verification:** 75 web tests pass

### V2-L1 — Title strings without separators (`STATEYou`)
- **Severity:** Low / deferred
- **Reason:** stored catalog title lacks separator; backend title generation required

## Loop summary

| Loop | Focus | Result |
| --- | --- | --- |
| 0 | Baseline from V1 + portfolio read | Defects H1–H4, M1–M3 recorded |
| 1 | Geometry / scroll / safe-area / dvh | Flex pin, min-height 0, 100svh/100dvh, safe vars |
| 2 | Information reduction | Compact header, home, composer, drawer chrome |
| 3 | Portfolio monochrome translation | Black/white/gray tokens, mono meta, thin rules |
| 4 | A11y contracts | Escape/focus retained; 44px; reduced-motion; file input |
| 5 | Hostile review + retest | Density reduced; no High remaining in scope |

## Density before → after (Mobile primary home)

| Metric | V1 | V2 |
| --- | --- | --- |
| Header status controls | 2-line pill (status + activity) | Single LINK word + dot |
| Hero containers | Mark + command card + search bar | Identity + search icon |
| Dominant accent | Ice-blue glow | White signal on black |
| Card nesting | Elevated command plate + list | Flat list rows with hairlines |
| Composer help | Full long sentence always | Truncated mono meta |

## Gates

- `pnpm --filter @aicl/web test` — 75 passed
- Full `pnpm check` — see final report
- Console 0/0 on isolated compiled production — see evidence dir

## Evidence (untracked)

```text
output/playwright/m10-spacex-interface-v2/
```
