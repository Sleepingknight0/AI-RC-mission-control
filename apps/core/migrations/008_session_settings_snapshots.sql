ALTER TABLE turns ADD COLUMN settings_revision INTEGER
  CHECK (settings_revision IS NULL OR settings_revision >= 0);
ALTER TABLE turns ADD COLUMN settings_snapshot_json TEXT
  CHECK (settings_snapshot_json IS NULL OR json_valid(settings_snapshot_json));

CREATE TRIGGER turns_validate_settings_snapshot_insert
BEFORE INSERT ON turns
WHEN (NEW.settings_revision IS NULL) <> (NEW.settings_snapshot_json IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Turn settings revision and snapshot must be stored together');
END;

CREATE TRIGGER turns_settings_snapshot_immutable
BEFORE UPDATE OF settings_revision, settings_snapshot_json ON turns
WHEN NEW.settings_revision IS NOT OLD.settings_revision
  OR NEW.settings_snapshot_json IS NOT OLD.settings_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'effective Turn settings are immutable');
END;

CREATE TABLE session_settings_audit (
  audit_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  device_id TEXT NOT NULL,
  prior_revision INTEGER NOT NULL CHECK (prior_revision >= 0),
  new_revision INTEGER NOT NULL CHECK (new_revision > prior_revision),
  old_value_json TEXT NOT NULL CHECK (json_valid(old_value_json)),
  new_value_json TEXT NOT NULL CHECK (json_valid(new_value_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER session_catalog_after_settings_update
AFTER UPDATE ON session_settings
WHEN NEW.revision <> OLD.revision
BEGIN
  UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
END;

DROP TRIGGER commands_validate_insert;

CREATE TRIGGER commands_validate_insert
BEFORE INSERT ON commands
WHEN NOT (
  (
    NEW.command_type IN (
      'turn.submit', 'turn.interrupt', 'approval.resolve',
      'session.create', 'session.resume'
    )
    AND NEW.state IN ('committed', 'rejected')
  ) OR (
    NEW.command_type IN (
      'session.rename', 'session.pin', 'session.archive', 'session.read.mark',
      'session.settings.update'
    )
    AND NEW.state IN ('terminal', 'rejected')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid command type or initial state');
END;
