# M9 UX/UI System Contract

## Ownership during the freeze

Grok commit `c2f1d481` owns the preserved visual baseline. Codex does not edit `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `apps/web/index.html`, visual assets, fonts, layout, or snapshots until integration is explicitly authorized.

## Data-driven surfaces

The later Web integration must render only normalized contracts:

- Provider Fleet from provider snapshot capabilities and freshness;
- Session browser from Catalog V2 pages and native discovery pages;
- control bar from selected provider/model capability options;
- approval policy and lease state from Core authority;
- attachment controls only for supported kinds;
- terminal details from bounded normalized activity fields.

Unsupported, unknown, stale, offline, and error are distinct display states. No missing numeric data becomes zero. IDs and paths are secondary technical metadata, while human titles are primary.

## Behavior invariants

- Reconnect requests authoritative snapshots and never auto-sends drafts or attachments.
- Session drafts and attachment selections remain isolated per Session/device.
- Conflict responses preserve user input and offer a refresh/reapply flow.
- Full Auto shows scope and countdown derived from server expiry.
- Large output/diffs use authenticated artifacts and bounded previews.
- Terminal view remains normalized evidence, not a PTY.

Responsive, typography, color, motion, and layout implementation remain Grok-owned until the freeze is removed. The complete integration protocol is in `docs/M9-WEB-INTEGRATION-CONTRACT.md`.
