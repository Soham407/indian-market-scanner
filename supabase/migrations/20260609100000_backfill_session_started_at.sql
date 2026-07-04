-- Backfill session_started_at for users who logged in before this feature existed.
-- Use account creation time as a conservative estimate (ensures they will be signed out
-- within 12h if they haven't had a fresh login yet).
-- Then enforce NOT NULL to catch future NULL writes.

UPDATE allowed_emails
SET session_started_at = created_at
WHERE session_started_at IS NULL;

ALTER TABLE allowed_emails
ALTER COLUMN session_started_at SET NOT NULL;
