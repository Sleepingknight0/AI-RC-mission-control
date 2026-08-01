CREATE TABLE journal_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE inbox_commands (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  state TEXT NOT NULL CHECK (state IN ('received', 'dispatching', 'completed', 'outcome_unknown')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE outbox_events (
  source_event_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
) STRICT;

CREATE INDEX ix_outbox_events_unacknowledged
ON outbox_events(created_at)
WHERE acknowledged_at IS NULL;

CREATE TABLE runtime_checkpoints (
  runtime_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  provider_session_id TEXT,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
