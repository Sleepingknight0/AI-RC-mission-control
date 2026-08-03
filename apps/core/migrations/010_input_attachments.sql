CREATE TABLE input_attachments (
  attachment_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  owner_device_id TEXT NOT NULL,
  begin_command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'document', 'archive')),
  media_type TEXT NOT NULL CHECK (media_type IN (
    'text/plain', 'text/markdown', 'image/png', 'image/jpeg',
    'image/gif', 'image/webp', 'application/pdf', 'application/zip'
  )),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN (
    'uploading', 'ready', 'referenced', 'rejected', 'expired', 'deleted'
  )),
  content BLOB,
  referenced_turn_id TEXT REFERENCES turns(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (
    (state IN ('ready', 'referenced') AND content IS NOT NULL AND length(content) = byte_length)
    OR (state NOT IN ('ready', 'referenced') AND content IS NULL)
  )
) STRICT;

CREATE INDEX ix_input_attachments_session_device
ON input_attachments(session_id, owner_device_id, created_at);

CREATE INDEX ix_input_attachments_expiry
ON input_attachments(expires_at)
WHERE state IN ('uploading', 'ready');

CREATE TABLE input_attachment_chunks (
  attachment_id TEXT NOT NULL REFERENCES input_attachments(attachment_id)
    ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 63),
  content BLOB NOT NULL CHECK (length(content) BETWEEN 1 AND 131072),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (attachment_id, chunk_index)
) STRICT;

CREATE TABLE turn_input_attachments (
  turn_id TEXT NOT NULL REFERENCES turns(id),
  attachment_id TEXT NOT NULL UNIQUE REFERENCES input_attachments(attachment_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  PRIMARY KEY (turn_id, ordinal)
) STRICT;

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
