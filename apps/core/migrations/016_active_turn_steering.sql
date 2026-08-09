DROP TRIGGER commands_validate_insert;

CREATE TRIGGER commands_validate_insert
BEFORE INSERT ON commands
WHEN NOT (
  (
    NEW.command_type IN (
      'turn.submit', 'turn.steer', 'turn.interrupt', 'approval.resolve',
      'session.create', 'session.resume', 'session.runtime.resume'
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
