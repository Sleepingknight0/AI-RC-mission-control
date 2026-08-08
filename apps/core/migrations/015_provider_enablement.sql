CREATE TABLE provider_enablement_commands (
  command_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  expected_enabled INTEGER NOT NULL CHECK (expected_enabled IN (0, 1)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'accepted', 'rejected', 'outcome_unknown'
  )),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (expected_enabled <> enabled),
  CHECK (
    (state = 'pending' AND result_json IS NULL AND terminal_at IS NULL)
    OR
    (state <> 'pending' AND result_json IS NOT NULL AND terminal_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX ix_provider_enablement_commands_provider
ON provider_enablement_commands(provider_id, created_at);
