# apps/web

React + Vite PWA. It consumes normalized protocol/read models only.

Prototype responsibilities:

- Core WebSocket client
- Mission Overview and selectable Session catalog
- Session Console with normalized streaming timeline and activity
- prompt composer, keyboard submission, local draft recovery, and stop action
- reconnect/replay and `outcome_unknown` recovery presentation
- non-modal Approval Dock and unified/side-by-side verified diff review
- responsive desktop/mobile mission-control layout
- mobile Overview and Health/Diff drawers with focus restoration
- bounded DOM rendering for 100,000-record timelines

It must not import Codex provider types or database modules.

Production builds connect to `${window.location.host}/ws`, selecting `wss:` on
HTTPS pages and `ws:` otherwise. `VITE_CORE_WS_URL` is only an explicit
development/test override. Each connect/reconnect obtains a validated one-time
ticket from `/runtime-config`; the ticket remains in memory and is never placed
in a URL or browser storage.
