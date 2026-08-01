# Grok Build frontend specialization

When the active task is under `prompts/grok/`, Grok owns frontend implementation only.

Allowed edit areas:

- `apps/web/**`
- `packages/ui-kit/**` when that package exists
- frontend tests and fixtures
- `reviews/grok/**`
- frontend-specific documentation

Do not change:

- normalized protocol schemas without an accepted architecture decision
- Core or Connector behavior
- database migrations
- Codex adapter code
- provider method names
- security or recovery semantics

Use typed protocol fixtures. If backend data is missing, add a mock fixture and document the required contract rather than inventing a backend field.
