-- Add nhptrad@gmail.com to allowed_emails whitelist
INSERT INTO allowed_emails (email, session_started_at)
VALUES
  ('nhptrad@gmail.com', NOW())
ON CONFLICT (email) DO NOTHING;
