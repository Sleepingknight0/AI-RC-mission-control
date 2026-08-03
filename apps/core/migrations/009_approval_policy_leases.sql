ALTER TABLE turns ADD COLUMN submitting_device_id TEXT;

CREATE TABLE approval_lease_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE approval_leases (
  lease_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  create_command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  device_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  core_boot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  CHECK (expires_at > issued_at),
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (state <> 'active' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  FOREIGN KEY (runtime_id, runtime_generation) REFERENCES runtimes(id, generation)
) STRICT;

CREATE UNIQUE INDEX uq_approval_lease_one_active_session
ON approval_leases(session_id) WHERE state = 'active';

CREATE INDEX ix_approval_lease_expiry
ON approval_leases(expires_at) WHERE state = 'active';

CREATE TABLE approval_lease_audit (
  audit_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES approval_leases(lease_id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  action TEXT NOT NULL CHECK (action IN (
    'create', 'use', 'revoke', 'expire', 'emergency_stop',
    'runtime_change', 'settings_change', 'core_restart'
  )),
  device_id TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE approval_policy_audit (
  audit_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  approval_id TEXT NOT NULL REFERENCES approval_requests(id),
  lease_id TEXT REFERENCES approval_leases(lease_id),
  policy TEXT NOT NULL CHECK (policy IN (
    'review', 'balanced', 'workspace_auto', 'full_auto_lease'
  )),
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved_once')),
  classifier TEXT NOT NULL,
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (runtime_id, runtime_generation) REFERENCES runtimes(id, generation)
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
      'approval.lease.revoke', 'approval.emergency_stop'
    )
    AND NEW.state IN ('terminal', 'rejected')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid command type or initial state');
END;
