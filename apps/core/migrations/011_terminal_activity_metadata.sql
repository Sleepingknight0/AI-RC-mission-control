ALTER TABLE tool_activities ADD COLUMN command_text TEXT;
ALTER TABLE tool_activities ADD COLUMN cwd_label TEXT;
ALTER TABLE tool_activities ADD COLUMN provider_started_at TEXT;
ALTER TABLE tool_activities ADD COLUMN provider_completed_at TEXT;
ALTER TABLE tool_activities ADD COLUMN stdout_preview TEXT NOT NULL DEFAULT '';
ALTER TABLE tool_activities ADD COLUMN stderr_preview TEXT NOT NULL DEFAULT '';
ALTER TABLE tool_activities ADD COLUMN stdout_truncated INTEGER NOT NULL DEFAULT 0
  CHECK (stdout_truncated IN (0, 1));
ALTER TABLE tool_activities ADD COLUMN stderr_truncated INTEGER NOT NULL DEFAULT 0
  CHECK (stderr_truncated IN (0, 1));
ALTER TABLE tool_activities ADD COLUMN stderr_available INTEGER NOT NULL DEFAULT 0
  CHECK (stderr_available IN (0, 1));
ALTER TABLE tool_activities ADD COLUMN output_artifact_json TEXT
  CHECK (output_artifact_json IS NULL OR json_valid(output_artifact_json));
ALTER TABLE tool_activities ADD COLUMN runtime_id TEXT;
ALTER TABLE tool_activities ADD COLUMN runtime_generation INTEGER
  CHECK (runtime_generation IS NULL OR runtime_generation > 0);
ALTER TABLE tool_activities ADD COLUMN provider_correlation_id TEXT;

UPDATE tool_activities
   SET command_text = CASE WHEN kind = 'command' THEN title ELSE NULL END,
       cwd_label = NULL,
       provider_started_at = created_at,
       provider_completed_at = CASE WHEN state = 'running' THEN NULL ELSE updated_at END,
       stdout_preview = output_preview,
       runtime_id = (SELECT runtime_id FROM turns WHERE turns.id = tool_activities.turn_id),
       runtime_generation = (
         SELECT runtime_generation FROM turns WHERE turns.id = tool_activities.turn_id
       ),
       cwd = NULL;

CREATE INDEX ix_tool_activities_turn_started
ON tool_activities(turn_id, provider_started_at, id);
