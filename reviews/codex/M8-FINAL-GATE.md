# M8 Daily-Use Final Gate

Date: 2026-08-03 (Asia/Bangkok)  
Host: Windows, Node v24.16.0, SQLite 3.53.0, Codex 0.146.0

## Result

PASS for a compiled, loopback-only, single-operator daily-use host. M8.5 remote
second-device/login acceptance is explicitly deferred and is not included in
this result.

## Repository gate

```powershell
pnpm check
```

Result: exit 0 in 84.9 seconds.

- source-map-free Web/Core/Connector/Host/Doctor/Maintenance builds passed
- strict TypeScript and ESLint passed across all workspaces
- 107 automated tests passed; the explicit real-provider test remained skipped
- compiled lifecycle start/health/status/stop and PID cleanup passed
- online backup → verify → stop → staged restore → restart passed
- repeated migration and corrupt-backup rejection passed
- clean-directory compiled install without `node_modules` or `.ts` passed
- fake-CLI Tailscale automation regression passed

## Real LocalAppData upgrade

Before mutation, the Core database reported zero running Turns. Production then
stopped gracefully.

```powershell
pnpm migrate
```

Result: Core 4→5 and Connector 2→3; `migrated=true`. A verified pre-migration
set was created at:

```text
%LOCALAPPDATA%\AICL Mission Control\backups\
aicl-backup-20260803012502030-e27ab5d9
```

Running `pnpm migrate` again returned Core 5 / Connector 3 and
`migrated=false` with no additional upgrade backup.

## Real backup and production restart

`pnpm backup` succeeded while compiled production was online. The resulting set
`aicl-backup-20260803012541435-304aaa8d` contains config metadata plus coherent
Core v5 and Connector v3 databases; `pnpm run backup:verify -BackupPath <path>`
returned `status=verified` after hash, full integrity, foreign-key, schema,
SQLite source, and domain-invariant checks.

`pnpm start` then returned ready at `http://127.0.0.1:8787/`:

```text
Core:      ready, connectorConnected=true, databaseSchemaVersion=5
Connector: ready, provider=codex, runtimeGeneration=27,
           Codex 0.146.0 compatibility=accepted
```

## Recovery boundary

- Direct live `.db`/WAL copying is not an operator command.
- Restore is offline, backup-root-contained, link-safe, verified, staged, and
  preserves replaced database/WAL/SHM files in a recovery directory.
- Config is captured for evidence but is not automatically restored.
- Default retention is 14 AICL-owned sets; unmanaged/invalid lookalike folders
  are not deleted.
- At-rest encryption is supplied by the host volume or external destination;
  the application does not claim backup encryption.

## Deferred work

M8.5 is not complete. Google Login and Cloudflare have not been implemented or
security-reviewed, and no second-device login proof exists. The application is
ready locally; remote identity/ingress requires a separate architecture choice.
