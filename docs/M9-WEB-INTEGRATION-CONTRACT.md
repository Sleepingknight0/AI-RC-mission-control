# M9 Web Integration Contract

## Compatibility rule

M8 envelopes remain valid. M9 adds message families instead of changing the frozen Web's required fields. An older Web may ignore unknown server envelopes and continue the existing Session console flow.

## Bootstrap snapshots

After `server.hello`, Core sends:

- `providers.snapshot` — `snapshotId`, positive `revision`, `observedAt`,
  `staleAt`, source, freshness, degraded flag, bounded
  provider/account/capability/model/usage evidence, and an optional notice;
- `sessions.catalog.snapshot` — bounded first page of AICL entries and a separate discovered-native page, filters, cursor, and catalog revision;
- `sessions.native.snapshot` — one bounded ephemeral Codex-native page for an
  exact provider/account identity, with freshness, truncation, and a redacted
  omission notice;
- `session.capabilities.snapshot` when a Session is selected;
- existing `sessions.snapshot` for M8 compatibility.

Live refresh uses the same full-snapshot envelopes. Stale data is carried with `freshness: stale`; it is never silently reused as live authority.

## Commands

All mutations carry stable `commandId`.

- `providers.refresh` with an empty strict payload; this is an idempotent query,
  not a mutation, so it has no `commandId` or command receipt. Core returns the
  retained snapshot immediately when present and asks the current Connector for
  a new revision. With no retained snapshot and no Connector it returns
  `PROVIDER_INVENTORY_UNAVAILABLE`.
- `sessions.catalog.list`
- `sessions.native.refresh` with exact provider/account IDs
- `session.create`, `session.resume`, `session.rename`, `session.pin`, `session.archive`
- `session.settings.update` with `expectedRevision`
- `approval.lease.create`, `approval.lease.revoke`, `approval.emergency_stop`
- `attachment.upload.begin`, `.chunk`, `.complete`, `.delete`
- extended `turn.submit` with optional `settingsRevision`, optional `deviceId`
  for M8 compatibility, and (after M9.8) `attachmentIds`. M9 Web must send both
  the displayed settings revision and its stable client-instance device ID;
  a Turn without `deviceId` cannot consume Full Auto authority.

Session metadata/read mutations receive `session.command.accepted` with the new
Session revision; conflicts and capability failures receive `command.rejected`
with stable code and current revision/details where safe. Provider/runtime Turn
commands retain the existing `command.accepted` shape.

## Provider payload

Provider entries expose sanitized IDs/labels, installed/enabled/auth/compatibility/adapter/freshness states, bounded accounts, and capability evidence. Each capability includes state, provenance, observation time, and optional bounded reason. Models contain provider-issued ID/display name, default/hidden flags, advertised input modalities, default reasoning effort, and bounded reasoning options. Usage contains values only when a real collector measured them. M9.2 may truthfully report model/usage state as unavailable or unsupported with empty arrays.

The snapshot is operational state, not durable Session history. Core accepts it
only from the active Connector socket with matching Connector, boot, Runtime,
and generation identity. Revisions increase within a boot; a new Connector boot
may restart at revision 1. Connector loss changes retained snapshot and provider
freshness to `stale`. A newly connected browser receives the latest retained
snapshot after `server.hello`; it may also request a refresh. Frozen M8 Web code
may ignore this new envelope without losing its existing Session flow.

## Session payload

Catalog V2 fields are defined in `docs/M9-SESSION-CATALOG.md`. `canControl` and
`canResume` are authoritative and fail closed when provider inventory is absent
or stale. Native records are never presented as imported AICL Sessions. Core
returns `SESSION_CATALOG_CURSOR_INVALID` or `SESSION_CATALOG_CURSOR_STALE`; Web
must discard the cursor and explicitly request a fresh first page. It must not
retry a metadata mutation automatically.

Native discovery rows contain provider/account/native IDs, human title,
bounded preview, authorized canonical project path and label, branch, provider
status, timestamps, pinned/archived flags, and `canResume`. They contain no
rollout path, account email, provider credential path, or raw provider payload.
The snapshot is replaced by revision and becomes `stale` when Connector
identity is lost. Web must not merge it into an AICL row by title or path.

`session.create` includes operator-chosen AICL Session ID, device ID, title,
provider/account, canonical project path, and optional model/reasoning values.
`session.resume` includes the exact provider-native Session ID selected from a
current snapshot. A successful first-stage mutation returns the ordinary
command acknowledgement; `session.provider.status` then reports `ready`,
`failed`, or `outcome_unknown`. Catalog rows expose
`providerBindingStatus = unbound | pending | ready | failed | outcome_unknown`.
Web must keep pending controls disabled and must never automatically retry a
failed or ambiguous provider operation.

## Settings and conflicts

`session.settings.snapshot` includes settings plus `revision` and `mutable`. On stale update, Core returns `SESSION_SETTINGS_CONFLICT` with current revision/settings. During an active Turn, semantic fields return `SESSION_BUSY`. Controls absent from the capability snapshot are disabled with the supplied reason.

`session.settings.update` is a strict full replacement containing `commandId`,
`sessionId`, `deviceId`, `expectedRevision`, and `settings`. Provider, account,
and project are binding-owned in M9 and return `SESSION_SETTING_IMMUTABLE` if
changed. `session.settings.get` is a read-only query. Web must replace its local
copy with every received snapshot and never retry a rejected CAS automatically.
`turn.submit.settingsRevision` is optional only for M8 compatibility; the M9
integration must send the currently displayed revision.

Execution modes are `ask`, `plan`, and `auto`. Approval policies are `review`, `balanced`, `workspace_auto`, and `full_auto_lease`; the two enums must never be collapsed.

The provider capability key `execution_modes` gates the control. Ask means one
interactive bounded Turn, plan means plan-first within the Turn, and auto means
multiple bounded steps within the Turn. Auto never changes approval policy,
never grants a lease, and never causes Core to submit another prompt.

## Lease lifecycle

`approval.lease.snapshot` exposes the Session lease-state revision plus up to 32
lease rows with opaque ID, scope, row revision, state, `expiresAt`, revocation
data, and server time. `approval.lease.create` requires command/session/device,
the current settings and lease-state revisions, exact provider/account/project,
current Runtime ID/generation, and 15/30/60 minutes. Revoke requires the owning
device and active lease row revision. Emergency stop revokes every active lease
for the Session and interrupts the active Turn. Commands are idempotent; stale
or replayed scopes reject. UI countdown is derived from `expiresAt`, but server
state is authoritative and Core restart revokes active authority.

## Attachments

`attachment.upload.begin` carries command/Session/device, a basename-only display
name, kind, allowlisted media type, byte length, SHA-256, and exact 128 KiB chunk
count. `attachment.command.accepted` returns the Core-allocated opaque ID,
`uploading` metadata, and 24-hour expiry. Each `attachment.upload.chunk` carries
only Session/device/ID/index/canonical base64; `attachment.upload.progress`
returns cumulative received and declared chunk counts. A changed duplicate index
is an error; a byte-identical retry is idempotent.

`attachment.upload.complete` is an idempotent command and returns the same
accepted envelope with `ready` metadata after length/hash/UTF-8 or image-magic
verification. `attachments.list` returns at most 256 non-deleted rows owned by
the exact Session/device. `attachment.delete` fails for a referenced row.
`turn.submit.attachmentIds` is optional, unique, and limited to eight; non-empty
references require `deviceId` and the displayed settings revision. Acceptance
atomically makes each row single-use (`referenced`) and records the IDs on the
Turn snapshot. Browser reconnect retrieves metadata but never sends a Turn.

Supported Codex inputs are UTF-8 `text/plain`/`text/markdown` and verified
PNG/JPEG/GIF/WebP only when live provider plus selected/default model evidence
advertises the necessary input capability. PDF/ZIP/document/archive and stale or
unsupported provider inputs reject with `ATTACHMENT_CAPABILITY_UNAVAILABLE` or a
more specific upload validation code. Web never receives a local path or byte
content. It must keep drafts per Session/device, upload before send, display the
server status/error, and never retry completion/Turn with a new command ID
without operator action.

## Terminal activity

`activity.started` and `activity.completed` retain the Prototype-compatible
fields and add the following optional fields. Grok may adopt them incrementally:

```text
command                    sanitized normalized command, or null for tools
cwdLabel                   "." or a project-relative label; never an absolute path
startedAt / completedAt    provider timestamps normalized to ISO-8601
stdoutPreview              at most 32 KiB of completed normalized output
stderrPreview              at most 32 KiB when the adapter can separate stderr
stdoutTruncated            true when the preview is not the complete output
stderrTruncated            true when the stderr preview is incomplete
stderrAvailable            false when the provider exposes only aggregated output
outputArtifact             authenticated text artifact for larger bounded output
runtimeId / generation     authenticated execution identity
providerCorrelationId      AICL-generated opaque correlation, never a provider item ID
eventSeq                   durable per-Session display order assigned by Core
```

Codex currently exposes aggregated command output, so `stderrAvailable` is
truthfully `false`; the UI must not manufacture a separate stderr stream. Output
artifacts use the existing authenticated `/artifacts/<opaque-id>` endpoint and
are downloadable only with the artifact capability. A missing artifact means
the bounded preview is the only retained evidence. Raw `cwd`, private user-home
paths, credentials, ANSI sequences, and raw provider item IDs must not render.

The frozen Web may continue consuming `title`, `outputPreview`, `durationMs`, and
`exitCode`. Later integration should prefer the richer fields when present and
show `unavailable`, not an empty success state, when the provider lacks evidence.
No activity envelope grants PTY, shell dispatch, or filesystem-read authority.

## Required state handling

Every M9 resource supports `loading`, `ready`, `stale`, `unavailable`, and `error` where applicable. One malformed provider/native Session is represented as a bounded notice without removing healthy siblings. Reconnect replaces snapshots by revision; it does not merge by title or retry mutations automatically.

## Frozen-Web integration checklist

After the freeze is removed, Grok/Codex integration must add reducer coverage for all new snapshots/commands, preserve unknown-envelope tolerance, wire real controls without hardcoded provider/model lists, keep per-Session drafts, and run Web typecheck/tests/build plus responsive/accessibility acceptance. No visual file changes are required for the non-visual backend checkpoints.
