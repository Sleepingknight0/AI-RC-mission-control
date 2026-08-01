CREATE TABLE tool_activities_v4 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('command', 'tool')),
  title TEXT NOT NULL,
  cwd TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'running', 'completed', 'failed', 'declined', 'interrupted', 'outcome_unknown'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  exit_code INTEGER,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  output_preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  display_seq INTEGER CHECK (display_seq IS NULL OR display_seq > 0)
) STRICT;

INSERT INTO tool_activities_v4
SELECT id, session_id, turn_id, kind, title, cwd, state, revision, exit_code,
       duration_ms, output_preview, created_at, updated_at, display_seq
  FROM tool_activities;

DROP TABLE tool_activities;
ALTER TABLE tool_activities_v4 RENAME TO tool_activities;

CREATE TABLE file_changes_v4 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  state TEXT NOT NULL CHECK (state IN (
    'running', 'completed', 'failed', 'declined', 'interrupted', 'outcome_unknown'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  files_json TEXT NOT NULL CHECK (json_valid(files_json)),
  additions INTEGER NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions INTEGER NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  diff_json TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  display_seq INTEGER CHECK (display_seq IS NULL OR display_seq > 0)
) STRICT;

INSERT INTO file_changes_v4
SELECT id, session_id, turn_id, state, revision, files_json, additions, deletions,
       diff_json, created_at, updated_at, display_seq
  FROM file_changes;

DROP TABLE file_changes;
ALTER TABLE file_changes_v4 RENAME TO file_changes;
