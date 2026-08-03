DROP TRIGGER IF EXISTS session_settings_after_session_insert;
DROP TRIGGER IF EXISTS session_catalog_after_settings_update;

ALTER TABLE session_settings RENAME TO session_settings_legacy;

CREATE TABLE session_settings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  provider_id TEXT NOT NULL DEFAULT 'codex',
  account_id TEXT,
  model TEXT,
  reasoning_level TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'ask'
    CHECK (execution_mode IN ('ask', 'plan', 'auto')),
  approval_policy TEXT NOT NULL DEFAULT 'review'
    CHECK (approval_policy IN ('review', 'balanced', 'workspace_auto', 'full_auto_lease')),
  sandbox_policy TEXT NOT NULL DEFAULT 'read_only'
    CHECK (sandbox_policy IN ('read_only', 'workspace_write')),
  network_policy TEXT NOT NULL DEFAULT 'denied'
    CHECK (network_policy IN ('denied', 'restricted')),
  project_path TEXT,
  branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO session_settings (
  session_id, revision, provider_id, account_id, model, reasoning_level,
  execution_mode, approval_policy, sandbox_policy, network_policy,
  project_path, branch, created_at, updated_at
)
SELECT legacy.session_id, legacy.revision, legacy.provider_id,
       legacy.account_id, legacy.model, legacy.reasoning_level,
       legacy.execution_mode, legacy.approval_policy,
       CASE
         WHEN legacy.project_path IS NOT NULL AND EXISTS (
           SELECT 1 FROM session_provider_bindings binding
            WHERE binding.session_id = legacy.session_id
              AND binding.state = 'ready'
         ) THEN legacy.sandbox_policy
         ELSE 'read_only'
       END,
       'denied', legacy.project_path, legacy.branch,
       legacy.created_at, legacy.updated_at
  FROM session_settings_legacy legacy;

DROP TABLE session_settings_legacy;

CREATE TRIGGER session_settings_after_session_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_settings (
    session_id, sandbox_policy, network_policy, created_at, updated_at
  ) VALUES (NEW.id, 'read_only', 'denied', NEW.created_at, NEW.updated_at);
END;

CREATE INDEX ix_session_settings_provider
ON session_settings(provider_id, account_id, project_path);

CREATE TRIGGER session_catalog_after_settings_update
AFTER UPDATE ON session_settings
WHEN NEW.revision <> OLD.revision
BEGIN
  UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
END;

DROP TRIGGER IF EXISTS session_catalog_after_update;

CREATE TRIGGER session_catalog_after_update
AFTER UPDATE ON sessions
WHEN NEW.title IS NOT OLD.title
  OR NEW.source IS NOT OLD.source
  OR NEW.pinned IS NOT OLD.pinned
  OR NEW.archived IS NOT OLD.archived
  OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
  UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER session_catalog_after_turn_insert
AFTER INSERT ON turns
BEGIN
  UPDATE sessions SET updated_at = NEW.updated_at WHERE id = NEW.session_id;
END;

CREATE TRIGGER session_catalog_after_turn_state_update
AFTER UPDATE OF state ON turns
WHEN NEW.state IS NOT OLD.state
BEGIN
  UPDATE sessions SET updated_at = NEW.updated_at WHERE id = NEW.session_id;
END;

CREATE TRIGGER session_catalog_after_approval_insert
AFTER INSERT ON approval_requests
BEGIN
  UPDATE sessions SET updated_at = NEW.updated_at WHERE id = NEW.session_id;
END;

CREATE TRIGGER session_catalog_after_approval_state_update
AFTER UPDATE OF state ON approval_requests
WHEN NEW.state IS NOT OLD.state
BEGIN
  UPDATE sessions SET updated_at = NEW.updated_at WHERE id = NEW.session_id;
END;

CREATE INDEX ix_turns_session_created
ON turns(session_id, created_at DESC, id DESC);

CREATE INDEX ix_approval_requests_session_state
ON approval_requests(session_id, state, created_at DESC, id DESC);
