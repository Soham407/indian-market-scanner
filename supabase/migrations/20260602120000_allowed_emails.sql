-- Whitelist of emails permitted to access the bot dashboard.
-- session_nonce is overwritten on each new login; old devices sign out via Realtime when it changes.
CREATE TABLE allowed_emails (
  email         TEXT PRIMARY KEY,
  session_nonce TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- Authenticated users can SELECT their own row only (required for Realtime subscription).
-- All INSERT/UPDATE/DELETE use the service role key server-side -- no user-level write access.
CREATE POLICY "read own row"
  ON allowed_emails
  FOR SELECT
  USING ((auth.jwt() ->> 'email') = email);

do $$
begin
  alter publication supabase_realtime add table public.allowed_emails;
exception when others then null;
end $$;
