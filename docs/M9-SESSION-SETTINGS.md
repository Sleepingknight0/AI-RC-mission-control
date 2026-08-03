# M9 Session Settings

## Authority and revisions

Core owns one settings row per AICL Session. Updates use `expectedRevision` compare-and-set. A stale browser receives `SESSION_SETTINGS_CONFLICT` with the current revision and redacted current settings. Session metadata revision and settings revision remain separate.

Settings include provider ID, account ID, model, reasoning effort, execution mode, approval policy, sandbox policy, network policy, canonical project path, and optional branch.

## Capability validation

Core validates requested values against the latest non-stale provider capability snapshot. Connector validates again before provider dispatch. A value is selectable only when evidence says it is supported. Unknown values fail closed with a stable unsupported-capability error.

Project paths are canonicalized in Connector against configured roots. The browser never grants a path exception. Branch is descriptive in M9 and is not a worktree or checkout command.

## Active Turn rule

Provider, account, model, reasoning, project, sandbox, network, execution mode, and approval policy cannot change while a Turn is executing. Rename, pin, archive, and read cursor are separate metadata operations.

## Effective Turn settings

When Core accepts `turn.submit`, it copies the settings revision and complete normalized effective settings onto the Turn in the same transaction. Connector receives that immutable snapshot. Later Session changes cannot alter an accepted Turn.

## Codex translation

- model and reasoning come from `model/list` and are sent as `turn/start` overrides;
- `plan` maps to the verified Codex collaboration-mode input when supported;
- `ask` and `auto` remain AICL orchestration states and do not imply approval bypass;
- sandbox/network values map only to installed-schema shapes;
- unsupported account/profile switching is rejected rather than simulated.
