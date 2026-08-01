CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT,
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE runtimes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  connector_id TEXT NOT NULL,
  connector_boot_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('ready', 'busy', 'lost', 'incompatible')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, generation)
) STRICT;

CREATE UNIQUE INDEX uq_runtime_one_active_per_session
ON runtimes(session_id)
WHERE state IN ('ready', 'busy');

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  command_type TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  received_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  terminal_at TEXT
) STRICT;

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  runtime_id TEXT,
  runtime_generation INTEGER,
  client_command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  provider_turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'running', 'interrupted', 'completed', 'failed', 'outcome_unknown'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  prompt TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (runtime_id, runtime_generation) REFERENCES runtimes(id, generation)
) STRICT;

CREATE UNIQUE INDEX uq_turn_one_executing_per_session
ON turns(session_id)
WHERE state = 'running';

CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  content TEXT NOT NULL,
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE session_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  schema_version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL CHECK (origin IN ('core', 'connector')),
  runtime_id TEXT,
  runtime_generation INTEGER,
  turn_id TEXT REFERENCES turns(id),
  source_connector_id TEXT,
  source_event_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  envelope_json TEXT CHECK (envelope_json IS NULL OR json_valid(envelope_json)),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq),
  CHECK (
    (origin = 'core' AND source_connector_id IS NULL AND source_event_id IS NULL)
    OR
    (origin = 'connector' AND source_connector_id IS NOT NULL AND source_event_id IS NOT NULL)
  ),
  CHECK (
    (runtime_id IS NULL AND runtime_generation IS NULL)
    OR
    (runtime_id IS NOT NULL AND runtime_generation IS NOT NULL)
  ),
  FOREIGN KEY (runtime_id, runtime_generation) REFERENCES runtimes(id, generation)
) STRICT;

CREATE UNIQUE INDEX uq_session_events_connector_source
ON session_events(source_connector_id, source_event_id)
WHERE source_connector_id IS NOT NULL AND source_event_id IS NOT NULL;

CREATE TABLE connector_receipts (
  connector_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, source_event_id)
) STRICT;
