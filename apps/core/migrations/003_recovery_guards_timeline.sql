ALTER TABLE turns ADD COLUMN display_seq INTEGER CHECK (display_seq IS NULL OR display_seq > 0);
ALTER TABLE assistant_messages ADD COLUMN display_seq INTEGER CHECK (display_seq IS NULL OR display_seq > 0);
ALTER TABLE tool_activities ADD COLUMN display_seq INTEGER CHECK (display_seq IS NULL OR display_seq > 0);
ALTER TABLE file_changes ADD COLUMN display_seq INTEGER CHECK (display_seq IS NULL OR display_seq > 0);

UPDATE turns SET display_seq = (
  SELECT MIN(seq) FROM session_events e
   WHERE e.turn_id = turns.id AND e.event_type = 'turn.started'
);
UPDATE assistant_messages SET display_seq = (
  SELECT MIN(seq) FROM session_events e
   WHERE e.session_id = assistant_messages.session_id
     AND json_extract(e.payload_json, '$.messageId') = assistant_messages.id
);
UPDATE tool_activities SET display_seq = (
  SELECT MIN(seq) FROM session_events e
   WHERE e.session_id = tool_activities.session_id
     AND json_extract(e.payload_json, '$.activity.activityId') = tool_activities.id
);
UPDATE file_changes SET display_seq = (
  SELECT MIN(seq) FROM session_events e
   WHERE e.session_id = file_changes.session_id
     AND json_extract(e.payload_json, '$.fileChange.fileChangeId') = file_changes.id
);

CREATE UNIQUE INDEX uq_turn_one_executing_per_runtime
ON turns(runtime_id, runtime_generation)
WHERE state = 'running';

CREATE TRIGGER commands_validate_insert
BEFORE INSERT ON commands
WHEN NEW.command_type NOT IN ('turn.submit', 'turn.interrupt', 'approval.resolve')
  OR NEW.state NOT IN ('committed', 'rejected')
BEGIN
  SELECT RAISE(ABORT, 'invalid command type or initial state');
END;

CREATE TRIGGER commands_validate_transition
BEFORE UPDATE OF state ON commands
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'committed' AND NEW.state IN ('dispatched', 'outcome_unknown')) OR
  (OLD.state = 'dispatched' AND NEW.state IN ('terminal', 'outcome_unknown')) OR
  (OLD.state = 'outcome_unknown' AND NEW.state = 'terminal')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid command state transition');
END;
