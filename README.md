# AICL / AI-RC Mission Control

A Windows-first multi-agent control plane for AI CLI providers. A browser Mission Control UI talks to a local Core over WebSocket; Core talks to a Connector that drives Codex over stdio and normalizes provider events for the UI.

This repository is a pnpm TypeScript monorepo. Package name: `aicl-mission-control`, version `0.0.0-prototype`. Prototype 0 through M10.2 is complete on `master`. Private Tailscale second-device acceptance (M8.5) remains deferred. Google identity and Cloudflare redesign remain unresolved.

## Architecture

```text
React browser (apps/web)
  -> AICL Core WebSocket (apps/core)
  -> AICL Connector (apps/connector)
  -> codex app-server --stdio
  -> normalized deltas / activity / approvals
  -> browser timeline and docks
```

Production adds `apps/host` to supervise Core and Connector.
Core can serve the compiled web build same-origin (default `http://127.0.0.1:8787/`).

Shared libraries live under `packages/` (config, domain, protocol, test-fixtures).

## Status (verified in-repo)

Completed milestone tracks (see `docs/05-IMPLEMENTATION-STATUS.md`):

| Track | Scope |
| --- | --- |
| M0-M7 | Empirical Codex spike, walking skeleton, first-token path, SQLite durability, approvals/artifacts, Mission Control UI, self-audit, clean-checkout final gate |
| M8 | Same-origin production host, short-lived browser tickets, LocalAppData config, production lifecycle/startup task, verified backup/restore (M8.6) |
| M9 | Remote AI workspace backend: provider capabilities, Session Catalog V2, Codex native create/resume, settings CAS, execution modes, approval leases, attachments |
| M10 | Mobile Account to Session shell, exact-profile routing, settings CAS, runtime fencing, provider visibility (M10.1), provider-native live Session mirror (M10.2) |

Deferred:

- M8.5 — Tailscale Serve second-device acceptance (automation present; operator deferred 2026-08-03)
- Google identity + Cloudflare remote-access redesign (unresolved, unimplemented)
- Product retention policy (explicitly deferred)

Evidence and gates live under `reviews/codex/`.

## Requirements

- Windows 10/11
- Git
- Node.js 24+ (engines.node: >=24.0.0)
- pnpm 10 (packageManager: pnpm@10.14.0)
- Codex CLI installed and logged in (for real-provider paths)

Optional: Grok Build or Claude Code for post-prototype review scripts only.

## Quick start (development)

```powershell
pnpm install
pnpm migrate
pnpm dev
```

Default development endpoints:

- Web: http://127.0.0.1:5173
- Core health: http://127.0.0.1:8787/health
- Connector health: http://127.0.0.1:8788/health

Toolchain check and Codex-driven milestone helpers:

```powershell
.\scripts\Check-Toolchain.ps1
.\scripts\Run-CodexSpike.ps1 -Runs 3
.\scripts\Invoke-Codex.ps1
pnpm next
pnpm check
```

## Production (single machine)

Stop pnpm dev first if it holds the default ports, then:

```powershell
pnpm build
pnpm start
pnpm status
pnpm doctor
pnpm stop
```

`pnpm start:production` builds then starts. Operator auto-start (interactive logon, limited privilege — not LocalSystem):

```powershell
pnpm startup:install
pnpm startup:uninstall
```

Config is created atomically on first Core/Connector start at:

```text
%LOCALAPPDATA%\AICL Mission Control\config.json
```

Databases, logs, and backups default under the same LocalAppData tree.
Supported environment overrides include `AICL_CONFIG_PATH`, `AICL_CORE_HOST`, `AICL_CORE_PORT`, `AICL_BROWSER_ORIGINS`, `AICL_CONNECTOR_PORT`, `AICL_PROVIDER`, `AICL_CODEX_PROFILE`, `CODEX_HOME`, `AICL_PROJECT_ROOTS`, `AICL_PROJECT_PATH`, `AICL_CORE_DB_PATH`, `AICL_CONNECTOR_DB_PATH`, `AICL_LOG_DIR`, and `AICL_BACKUP_DIR`.

Backup / restore (do not copy live WAL files by hand):

```powershell
pnpm backup
pnpm run backup:verify -BackupPath 'C:\path\to\aicl-backup-...'
pnpm stop
pnpm run restore -BackupPath 'C:\path\to\aicl-backup-...'
pnpm start
```

Optional Tailscale Serve helpers (second-device gate still deferred):

```powershell
pnpm remote:configure
pnpm start
pnpm remote:status
pnpm run doctor
```

## Repository layout

```text
.
|-- apps/
|   |-- web/          # React Mission Control UI
|   |-- core/         # Durable Core + WebSocket + production static host
|   |-- connector/    # Codex app-server adapter + journal
|   `-- host/         # Production supervisor
|-- packages/         # config, domain, protocol, test-fixtures
|-- scripts/          # toolchain, lifecycle, backup, remote helpers
|-- docs/             # Scope, ADRs, milestone plans, M9 specs
|-- prompts/          # Codex / Grok / Claude prompt packs
|-- reviews/          # Milestone evidence
|-- spikes/           # Codex app-server measurement harness
|-- START-HERE.md     # Operator onboarding (Thai)
|-- AGENTS.md         # Shared agent rules
|-- CLAUDE.md         # Claude read-only review posture
|-- package.json      # Root scripts (dev/build/start/check/...)
|-- pnpm-workspace.yaml
`-- README.md
```

## Document authority

When documents conflict, prefer this order:

1. Live test results and generated schema from the installed Codex binary
2. `docs/00-PROTOTYPE-0-SCOPE.md`
3. `docs/01-ARCHITECTURE-DECISIONS.md`
4. `AGENTS.md`
5. The task prompt currently running
6. `docs/spec/AICL-MISSION-CONTROL-SPEC-V2.2.md`
7. Unevidenced AI proposals

Current milestone truth: `docs/05-IMPLEMENTATION-STATUS.md`.

## Secrets / local state

Treat LocalAppData config, databases, logs, backups, and Codex credentials as operator secrets. They are not stored in this repository.
