-- Fix Realtime delivery for allowed_emails.
-- The previous email-equality RLS policy prevented postgres_changes events from being
-- delivered because the Realtime authorizer cannot evaluate auth.jwt() in that context.
-- Using USING (true) TO authenticated matches the pattern used by bot_settings and other
-- tables where Realtime is confirmed working.

ALTER TABLE allowed_emails REPLICA IDENTITY FULL;

DROP POLICY "read own row" ON allowed_emails;
CREATE POLICY "read own row"
  ON allowed_emails
  FOR SELECT
  TO authenticated
  USING (true);
