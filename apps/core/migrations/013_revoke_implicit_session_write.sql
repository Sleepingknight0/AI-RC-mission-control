-- Migration 006 assigned workspace_write while creating settings for existing
-- Sessions, so no pre-v13 row can prove that filesystem-write authority was an
-- explicit operator choice. Revoke it unconditionally; a later settings CAS may
-- grant it only after current provider and canonical project validation.
UPDATE session_settings
   SET sandbox_policy = 'read_only',
       network_policy = 'denied',
       revision = revision + CASE
         WHEN sandbox_policy <> 'read_only' OR network_policy <> 'denied' THEN 1
         ELSE 0
       END,
       updated_at = CASE
         WHEN sandbox_policy <> 'read_only' OR network_policy <> 'denied'
           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ELSE updated_at
       END;
