ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled Session'
  CHECK (length(title) BETWEEN 1 AND 160);
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'aicl'
  CHECK (source IN ('aicl', 'imported'));
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0
  CHECK (pinned IN (0, 1));
ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0
  CHECK (archived IN (0, 1));
ALTER TABLE sessions ADD COLUMN session_revision INTEGER NOT NULL DEFAULT 0
  CHECK (session_revision >= 0);

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
  sandbox_policy TEXT NOT NULL DEFAULT 'workspace_write'
    CHECK (sandbox_policy IN ('read_only', 'workspace_write')),
  network_policy TEXT NOT NULL DEFAULT 'restricted'
    CHECK (network_policy IN ('denied', 'restricted')),
  project_path TEXT,
  branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO session_settings (session_id, created_at, updated_at)
SELECT id, created_at, updated_at FROM sessions;

CREATE TRIGGER session_settings_after_session_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_settings (session_id, created_at, updated_at)
  VALUES (NEW.id, NEW.created_at, NEW.updated_at);
END;

CREATE TABLE session_read_cursors (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  device_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, device_id)
) STRICT;

CREATE TABLE session_catalog_audit (
  audit_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  action TEXT NOT NULL CHECK (action IN ('rename', 'pin', 'archive', 'unarchive', 'mark_read')),
  device_id TEXT NOT NULL,
  old_value_json TEXT NOT NULL CHECK (json_valid(old_value_json)),
  new_value_json TEXT NOT NULL CHECK (json_valid(new_value_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_session_catalog_order
ON sessions(archived, pinned DESC, updated_at DESC, id ASC);

CREATE INDEX ix_session_settings_provider
ON session_settings(provider_id, account_id, project_path);

CREATE TABLE session_catalog_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

INSERT INTO session_catalog_state (singleton, revision) VALUES (1, 1);

CREATE TRIGGER session_catalog_after_insert
AFTER INSERT ON sessions
BEGIN
  UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER session_catalog_after_update
AFTER UPDATE ON sessions
BEGIN
  UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER session_catalog_after_delete
AFTER DELETE ON sessions
BEGIN
  UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
END;

DROP TRIGGER commands_validate_insert;

CREATE TRIGGER commands_validate_insert
BEFORE INSERT ON commands
WHEN NOT (
  (
    NEW.command_type IN ('turn.submit', 'turn.interrupt', 'approval.resolve')
    AND NEW.state IN ('committed', 'rejected')
  ) OR (
    NEW.command_type IN ('session.rename', 'session.pin', 'session.archive', 'session.read.mark')
    AND NEW.state IN ('terminal', 'rejected')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid command type or initial state');
END;
