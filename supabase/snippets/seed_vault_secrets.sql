-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor).
-- It seeds the two vault secrets the pg_cron jobs need to call Edge Functions.
--
-- How to get the anon JWT:
--   Dashboard → Project Settings → API → "anon public" key
--   Copy the eyJ... string (NOT the sb_publishable_ format)

do $$
declare
  v_project_url text := 'https://gykgrrjiqkucstcyrgxp.supabase.co';
  v_anon_jwt    text := 'PASTE_YOUR_ANON_JWT_HERE';  -- eyJ...
begin
  -- Upsert market_sniper_project_url
  if exists (select 1 from vault.secrets where name = 'market_sniper_project_url') then
    update vault.secrets
       set secret = v_project_url
     where name = 'market_sniper_project_url';
  else
    perform vault.create_secret(v_project_url, 'market_sniper_project_url');
  end if;

  -- Upsert market_sniper_anon_jwt
  if exists (select 1 from vault.secrets where name = 'market_sniper_anon_jwt') then
    update vault.secrets
       set secret = v_anon_jwt
     where name = 'market_sniper_anon_jwt';
  else
    perform vault.create_secret(v_anon_jwt, 'market_sniper_anon_jwt');
  end if;
end $$;

-- Verify (should return 2 rows):
select name, length(decrypted_secret) as secret_len
from vault.decrypted_secrets
where name in ('market_sniper_project_url', 'market_sniper_anon_jwt');
