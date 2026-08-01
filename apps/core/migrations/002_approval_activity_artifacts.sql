CREATE TABLE tool_activities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('command', 'tool')),
  title TEXT NOT NULL,
  cwd TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'running', 'completed', 'failed', 'declined', 'interrupted'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  exit_code INTEGER,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  output_preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE file_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  state TEXT NOT NULL CHECK (state IN (
    'running', 'completed', 'failed', 'declined', 'interrupted'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  files_json TEXT NOT NULL CHECK (json_valid(files_json)),
  additions INTEGER NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions INTEGER NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  diff_json TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  provider_correlation_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('command', 'file_change')),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'approved_once', 'declined', 'expired', 'invalidated'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  expires_at TEXT NOT NULL,
  resolved_by_device_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (runtime_id, provider_correlation_id),
  FOREIGN KEY (runtime_id, runtime_generation)
    REFERENCES runtimes(id, generation)
) STRICT;

CREATE INDEX ix_approval_pending_session
ON approval_requests(session_id, created_at)
WHERE state = 'pending';

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content BLOB NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(content) = byte_length)
) STRICT;

CREATE TABLE artifact_ingests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifact_ingest_chunks (
  artifact_id TEXT NOT NULL REFERENCES artifact_ingests(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content BLOB NOT NULL,
  PRIMARY KEY (artifact_id, chunk_index)
) STRICT;
