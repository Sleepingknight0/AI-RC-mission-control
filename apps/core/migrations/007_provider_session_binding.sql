CREATE TABLE session_provider_bindings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  requested_provider_session_id TEXT,
  provider_session_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'ready', 'failed', 'outcome_unknown'
  )),
  failure_code TEXT,
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state <> 'ready' OR provider_session_id IS NOT NULL),
  CHECK (state <> 'failed' OR failure_code IS NOT NULL),
  FOREIGN KEY (runtime_id, runtime_generation) REFERENCES runtimes(id, generation)
) STRICT;

CREATE UNIQUE INDEX uq_provider_session_binding_ready
ON session_provider_bindings(provider_id, account_id, provider_session_id)
WHERE state = 'ready';

CREATE TRIGGER session_catalog_after_binding_insert
AFTER INSERT ON session_provider_bindings
BEGIN
  UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER session_catalog_after_binding_update
AFTER UPDATE ON session_provider_bindings
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
    NEW.command_type IN ('session.rename', 'session.pin', 'session.archive', 'session.read.mark')
    AND NEW.state IN ('terminal', 'rejected')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid command type or initial state');
END;
