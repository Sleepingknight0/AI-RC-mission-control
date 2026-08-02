# Codex Prompt — Execute One M8 Daily-Use Milestone

Implement the first incomplete M8 milestone in
`docs/05-IMPLEMENTATION-STATUS.md`, then stop. Prototype 0 and M7.2 are already
complete; do not redo them.

Before modifying files, read `AGENTS.md`, the accepted architecture decisions,
implementation status, execution plan, M7.2 final-gate evidence, README, and
the relevant implementation/tests. Codex owns implementation, frontend, tests,
documentation, and integration. External AI review is optional.

## Goal

Turn the development prototype into a reliable, single-operator Windows
daily-use application that remains loopback-only and can later be exposed
privately through Tailscale Serve.

## Milestones

### M8.1 — Same-origin production host

- Build the Vite frontend and serve it from Core.
- Reserve `/health`, `/ws`, `/connector`, and `/artifacts/*`.
- Add safe static assets and HTML-navigation SPA fallback.
- Derive `ws:`/`wss:` from `window.location` by default.
- Keep `VITE_CORE_WS_URL` only as a development/test override.
- Keep Core and Connector on loopback and add production-host smoke tests.

### M8.2 — Runtime browser authentication

- Do not bake a long-lived browser capability into the production bundle.
- Add a same-origin bootstrap that returns a bounded short-lived WebSocket
  ticket while keeping Connector authentication separate.
- Keep secrets out of URLs, logs, storage, source maps, and Git.
- Enforce exact Origin, expiry, one-time/replay semantics, and restart behavior.
- Preserve all existing WebSocket security tests.

### M8.3 — Persistent local configuration

- Add typed, versioned configuration under LocalAppData.
- Support Core host/port, canonical allowed roots, default project, Codex
  profile/CODEX_HOME, database, log, and backup paths.
- Allow environment overrides for development/tests.
- Never store provider credentials in configuration.

### M8.4 — Production lifecycle

- Add build/start/stop/status/doctor/startup-task/backup/restore commands.
- Run compiled JavaScript without Vite or `tsx watch`.
- Install startup under the interactive operator, never LocalSystem.
- Add graceful process-tree shutdown, bounded logs, and redaction.

### M8.5 — Tailscale Serve deployment

- Keep the app on `127.0.0.1` and expose it privately with Tailscale Serve.
- Never enable Funnel.
- Configure the exact `https://*.ts.net` Origin.
- Diagnose app, Tailscale, Serve, Connector, Codex compatibility, and database
  failures separately.
- Do not claim mobile access until tested from a second tailnet device.

### M8.6 — Backup, migration, and clean-install gate

- Add coherent SQLite backup, verified restore, pre-migration backup,
  retention, and integrity checks.
- Test empty install, upgrade, repeated migration, Core/Connector restart,
  reboot simulation, and corrupt-backup rejection.
- Run a clean-directory production gate and record evidence in
  `reviews/codex/M8-FINAL-GATE.md`.

## Invariants and exclusions

- Web receives normalized protocol events only.
- Core and Connector remain separate; Connector never opens the Core database.
- One executing Turn per Session; never auto-resubmit ambiguous work.
- Runtime generation and approval compare-and-set fencing remain intact.
- No unrestricted shell/filesystem endpoint or public Internet exposure.
- Do not add providers, multi-user SaaS, PTY, worktrees, notifications, PWA,
  installer, or updater during M8.
- Do not weaken or delete tests to pass a gate.

## Completion

Update implementation status, execution plan, and handoff. Report the completed
or blocked sub-milestone, changed files, exact checks, local demo path, remote
demo only when proven, security/recovery evidence, limitations, and the next
single M8 milestone. Do not push or start the next milestone.
