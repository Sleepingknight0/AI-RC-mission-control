# M9 Web Integration Contract

## Compatibility rule

M8 envelopes remain valid. M9 adds message families instead of changing the frozen Web's required fields. An older Web may ignore unknown server envelopes and continue the existing Session console flow.

## Bootstrap snapshots

After `server.hello`, Core sends:

- `providers.snapshot` — inventory ID/revision, observed/expires timestamps, source, degraded flag, provider/account/capability/model data;
- `sessions.catalog.snapshot` — bounded first page of AICL entries and a separate discovered-native page, filters, cursor, and catalog revision;
- `session.capabilities.snapshot` when a Session is selected;
- existing `sessions.snapshot` for M8 compatibility.

Live refresh uses the same full-snapshot envelopes. Stale data is carried with `freshness: stale`; it is never silently reused as live authority.

## Commands

All mutations carry stable `commandId`.

- `providers.refresh`
- `sessions.catalog.list`
- `session.create`, `session.resume`, `session.rename`, `session.pin`, `session.archive`
- `session.settings.update` with `expectedRevision`
- `approval.lease.create`, `approval.lease.revoke`, `approval.emergency_stop`
- `attachment.upload.begin`, `.chunk`, `.complete`, `.delete`
- extended `turn.submit` with optional `settingsRevision` and `attachmentIds`

Each accepted mutation receives `command.accepted`; conflicts and capability failures receive `command.rejected` with stable code and current revision/details where safe.

## Provider payload

Provider entries expose sanitized IDs/labels, installed/enabled/auth/compatibility/adapter/freshness states, bounded accounts, and a capability map. Each capability includes state, provenance, and optional bounded reason. Models contain provider-issued ID/display name, default/hidden flags, advertised input modalities, default reasoning effort, and bounded reasoning options. Usage contains values only when a real collector measured them.

## Session payload

Catalog V2 fields are defined in `docs/M9-SESSION-CATALOG.md`. `canControl`, `canResume`, and supported actions are authoritative. Native records are never presented as imported AICL Sessions. Cursor expiry or stale catalog revision returns a fresh first page.

## Settings and conflicts

`session.settings.snapshot` includes settings plus `revision` and `mutable`. On stale update, Core returns `SESSION_SETTINGS_CONFLICT` with current revision/settings. During an active Turn, semantic fields return `SESSION_BUSY`. Controls absent from the capability snapshot are disabled with the supplied reason.

Execution modes are `ask`, `plan`, and `auto`. Approval policies are `review`, `balanced`, `workspace_auto`, and `full_auto_lease`; the two enums must never be collapsed.

## Lease lifecycle

`approval.lease.snapshot` exposes state, scopes, revision, `expiresAt`, and server time. Create accepts only 15/30/60 minutes plus current Session/settings/Runtime/device fences. Revoke and emergency stop are idempotent. The UI derives countdown from `expiresAt` but treats server state as authoritative.

## Attachments

Upload begin returns attachment ID, fixed chunk bytes/count, and expiry. Chunk acknowledgement is per index. Completion returns ready metadata (name, kind, media type, bytes, hash, preview availability). A Turn references ready IDs; reconnect never submits them. Unsupported kind, MIME mismatch, expiry, ownership mismatch, and hash failure use distinct stable errors.

## Terminal activity

M9 activity includes command, redacted working-directory label, kind/status, start/end/duration, exit code, bounded stdout/stderr previews, truncation flags, optional authenticated output artifact, Runtime/Turn/activity IDs, provider correlation label, and durable event sequence. Absolute private paths and raw provider IDs are omitted or redacted.

## Required state handling

Every M9 resource supports `loading`, `ready`, `stale`, `unavailable`, and `error` where applicable. One malformed provider/native Session is represented as a bounded notice without removing healthy siblings. Reconnect replaces snapshots by revision; it does not merge by title or retry mutations automatically.

## Frozen-Web integration checklist

After the freeze is removed, Grok/Codex integration must add reducer coverage for all new snapshots/commands, preserve unknown-envelope tolerance, wire real controls without hardcoded provider/model lists, keep per-Session drafts, and run Web typecheck/tests/build plus responsive/accessibility acceptance. No visual file changes are required for the non-visual backend checkpoints.
