-- Track when the current session was started so we can enforce a 12-hour
-- absolute session limit. Set by the OAuth callback on each new login;
-- never overwritten by the per-tab nonce claim.
ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ;
