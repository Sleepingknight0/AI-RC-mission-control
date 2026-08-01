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

It must not import Codex provider types or database modules.
