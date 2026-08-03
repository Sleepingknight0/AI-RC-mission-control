# M9 Session Settings

## Authority and revisions

Core owns one settings row per AICL Session. Updates use `expectedRevision` compare-and-set. A stale browser receives `SESSION_SETTINGS_CONFLICT` with the current revision and redacted current settings. Session metadata revision and settings revision remain separate.

Settings include provider ID, account ID, model, reasoning effort, execution mode, approval policy, sandbox policy, network policy, canonical project path, and optional branch.

Schema 12 makes `read_only` plus network `denied` the database and trigger
defaults. Schema 13 additionally revokes `workspace_write` from every pre-v13
row, including ready/non-null rows, because migration 006 did not record proof
of an explicit operator choice, canonical root, or current capability. A later
revision-fenced settings CAS may grant write only after current authoritative
validation; no migration, backfill, implicit creation, or missing field grants
write authority.

The update command replaces the complete document; partial patches are not
accepted. Core returns `session.settings.snapshot` on subscribe, explicit get,
successful update, and revision conflict. A no-op update is idempotently
accepted without incrementing the revision.

## Capability validation

Core validates requested values against the latest non-stale provider capability snapshot. Connector validates again before provider dispatch. A value is selectable only when evidence says it is supported. Unknown values fail closed with a stable unsupported-capability error.

Project paths are canonicalized in Connector against configured roots. The browser never grants a path exception. Branch is descriptive in M9 and is not a worktree or checkout command.

Provider, account, and project are fixed once selected by Session
create/import because changing them would silently rebind provider authority.
M9.5 therefore rejects such changes with `SESSION_SETTING_IMMUTABLE`; a new
Session is required. Model/reasoning changes require current provider evidence.
Execution/policy fields exist in the authoritative document but changes fail
closed until their M9.6/M9.7 enforcement slices are active.

## Active Turn rule

Provider, account, model, reasoning, project, sandbox, network, execution mode, and approval policy cannot change while a Turn is executing. Rename, pin, archive, and read cursor are separate metadata operations.

## Effective Turn settings

When Core accepts `turn.submit`, it copies the settings revision and complete normalized effective settings onto the Turn in the same transaction. Connector receives that immutable snapshot. Later Session changes cannot alter an accepted Turn.

M8 clients may omit `settingsRevision`; Core snapshots the current revision for
compatibility. M9 clients should always send it. A supplied stale value is
rejected before creating or dispatching a Turn.

## Codex translation

- model and reasoning come from `model/list` and are sent as `turn/start` overrides;
- installed Codex `turn/start` has no collaboration-mode request field, so AICL
  supplies a bounded adapter instruction before the unchanged operator prompt;
- `ask` requests interactive one-Turn work, `plan` requires plan-first behavior,
  and `auto` permits multiple bounded steps inside that same Turn;
- all modes remain AICL orchestration states and never imply approval bypass,
  automatic prompt resubmission, or creation of another Turn;
- sandbox/network values map only to installed-schema shapes;
- unsupported account/profile switching is rejected rather than simulated.
