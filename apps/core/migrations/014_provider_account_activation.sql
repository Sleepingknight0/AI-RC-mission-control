ALTER TABLE session_provider_bindings
ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);

CREATE TABLE provider_account_commands (
  command_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  expected_account_revision INTEGER NOT NULL CHECK (expected_account_revision > 0),
  expected_runtime_id TEXT NOT NULL,
  expected_runtime_generation INTEGER NOT NULL CHECK (expected_runtime_generation > 0),
  next_runtime_id TEXT NOT NULL,
  next_runtime_generation INTEGER NOT NULL CHECK (next_runtime_generation > 0),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'accepted', 'rejected', 'outcome_unknown'
  )),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (state = 'pending' AND result_json IS NULL AND terminal_at IS NULL)
    OR
    (state <> 'pending' AND result_json IS NOT NULL AND terminal_at IS NOT NULL)
  )
) STRICT;

DROP TRIGGER commands_validate_insert;

CREATE TRIGGER commands_validate_insert
BEFORE INSERT ON commands
WHEN NOT (
  (
    NEW.command_type IN (
      'turn.submit', 'turn.interrupt', 'approval.resolve',
      'session.create', 'session.resume', 'session.runtime.resume'
    )
    AND NEW.state IN ('committed', 'rejected')
  ) OR (
    NEW.command_type IN (
      'session.rename', 'session.pin', 'session.archive', 'session.read.mark',
      'session.settings.update', 'approval.lease.create',
      'approval.lease.revoke', 'approval.emergency_stop',
      'attachment.upload.begin', 'attachment.upload.complete', 'attachment.delete'
    )
    AND NEW.state IN ('terminal', 'rejected')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid command type or initial state');
END;
