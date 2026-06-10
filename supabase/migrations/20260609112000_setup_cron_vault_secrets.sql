-- Set up vault secrets for pg_cron to call edge functions
-- The cron jobs use these to build the HTTP POST URL and auth header

INSERT INTO vault.decrypted_secrets (name, secret)
VALUES
  ('bot_project_url', 'https://indian-market-scanner.vercel.app'),
  ('bot_anon_jwt', 'sb_publishable_JUCxMDeCTv-b8QKu3bRHHA_wpLs6dLY')
ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;

INSERT INTO vault.decrypted_secrets (name, secret)
VALUES
  ('market_sniper_project_url', 'https://indian-market-scanner.vercel.app'),
  ('market_sniper_anon_jwt', 'sb_publishable_JUCxMDeCTv-b8QKu3bRHHA_wpLs6dLY')
ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;
