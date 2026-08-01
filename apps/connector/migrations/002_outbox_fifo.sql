CREATE TABLE outbox_events_v2 (
  journal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_id TEXT NOT NULL UNIQUE,
  connector_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
) STRICT;

INSERT INTO outbox_events_v2 (
  source_event_id, connector_id, runtime_id, runtime_generation,
  envelope_json, created_at, acknowledged_at
)
SELECT source_event_id, connector_id, runtime_id, runtime_generation,
       envelope_json, created_at, acknowledged_at
FROM outbox_events
ORDER BY created_at, source_event_id;

DROP TABLE outbox_events;
ALTER TABLE outbox_events_v2 RENAME TO outbox_events;

CREATE INDEX ix_outbox_events_unacknowledged
ON outbox_events(journal_seq)
WHERE acknowledged_at IS NULL;
