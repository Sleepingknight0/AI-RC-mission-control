# Frontend Brief — Aerospace Mission Control

## Product feeling

The interface should feel like an operational control surface for multiple autonomous processes: dense, precise, calm, and readable in one second. It may be inspired by modern aerospace control rooms, but it must not copy SpaceX branding, logos, or proprietary screens.

## Visual principles

- Near-black background, white/gray hierarchy, one cool accent.
- Red and amber are reserved for error, lost runtime, or required approval.
- Monospace for state, paths, time, token counts, IDs, and command output.
- Sans-serif for labels and prose.
- Thin dividers and compact spacing; avoid decorative cards everywhere.
- No glow-heavy cyberpunk treatment.
- No continuous animation. Motion only communicates state transition.
- Support `prefers-reduced-motion`.

## Initial design tokens

```css
--surface-0: #06080b;
--surface-1: #0b0f14;
--surface-2: #111820;
--line: rgba(255, 255, 255, 0.10);
--text-1: rgba(255, 255, 255, 0.94);
--text-2: rgba(255, 255, 255, 0.66);
--text-3: rgba(255, 255, 255, 0.42);
--accent: #8bd8ff;
--warning: #f2b84b;
--danger: #ff6b6b;
--success: #8fd19e;
```

Treat these as starting values. Maintain WCAG contrast and avoid using color as the only status signal.

## Required desktop layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ AICL MISSION CONTROL       CORE ONLINE   CONNECTOR ONLINE   08:42:17 ICT   │
├──────────────────────┬───────────────────────────────────────┬───────────────┤
│ MISSION OVERVIEW     │ SESSION CONSOLE                       │ SYSTEM HEALTH │
│                      │                                       │               │
│ session strip        │ timeline / streaming output           │ DB / WS /     │
│ session strip        │                                       │ connector /   │
│ session strip        │                                       │ provider      │
│                      │                                       │               │
├──────────────────────┴───────────────────────────────────────┴───────────────┤
│ APPROVAL DOCK — appears only when actionable                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ PROMPT COMPOSER                                               SEND / STOP   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Session strip

One row must show, without opening the Session:

- provider and model
- profile
- project/cwd abbreviation
- state
- elapsed time
- token or usage summary when available
- pending approval count
- last activity time

State must be readable from icon, text, and color—not color alone.

## Timeline behavior

- Use stable item IDs.
- Coalesce streaming text visually without remounting the whole item.
- Do not force-scroll when the operator has scrolled upward.
- Show an unread marker and a single “return to live” action.
- Preserve scroll anchor when the Approval Dock or diff drawer opens.
- Command output may collapse but must retain failure context.
- `outcome_unknown` must be explicit and visually distinct from failed/completed.

## Approval Dock

- Sticky and non-modal.
- Never cover the prompt or move the timeline scroll position unexpectedly.
- Show action, working directory, risk category, runtime generation, and expiry.
- Actions: approve once, decline. Session-wide approval appears only when the provider capability explicitly supports it.
- After reconnect, reload authoritative approval state before enabling buttons.

## Diff review

- Desktop: side drawer or dedicated split view.
- Mobile: full-screen sheet with file navigation.
- Inline diff only under the protocol limit.
- Large diff loads from artifact metadata and verifies expected hash.
- Preserve current timeline position when the diff closes.

## Mobile priorities

At approximately 390 × 844:

1. Session header/state
2. Timeline
3. Approval Dock
4. Composer
5. Overview and health in drawers

Avoid shrinking the three-column desktop layout into unreadable columns.

## Frontend implementation constraints

- Consume types from `packages/protocol`.
- Do not import provider-specific types.
- Use mock fixtures for every important state.
- Keep WebSocket state and render state separate.
- Treat durable replay and ephemeral live frames differently.
- Provide loading, disconnected, reconnecting, stale approval, and private-network-unavailable states.
- Do not invent backend fields. Record missing fields in `reviews/grok/frontend-handoff.md`.

## Required visual states

- idle Session
- running Turn with streaming text
- running command with output
- pending approval
- interrupted Turn
- provider lost
- `outcome_unknown`
- browser reconnecting
- durable replay in progress
- Core available but Connector offline
- empty first-run state
