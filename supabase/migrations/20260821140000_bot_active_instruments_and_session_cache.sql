-- ADR-0004: Pre-Market Daily Instrument Sync & Dynamic Option Discovery
-- Replaces static JSON bundling with daily 08:30 AM IST automated sync.

create table if not exists public.bot_active_instruments (
  id uuid primary key default gen_random_uuid(),
  exchange text not null default 'NFO',
  instrument_type text not null default 'OPTIDX',
  name text not null default 'NIFTY',
  symbol text not null,
  token text not null,
  strike numeric(14, 4) not null,
  option_type text not null,
  expiry_date date not null,
  synced_at timestamptz not null default now(),
  constraint bot_active_instruments_symbol_token_key unique (token),
  constraint bot_active_instruments_strike_type_expiry_key unique (name, expiry_date, strike, option_type)
);

create index if not exists bot_active_instruments_lookup_idx
  on public.bot_active_instruments (name, expiry_date, strike, option_type);

alter table public.bot_active_instruments enable row level security;
grant select on public.bot_active_instruments to anon, authenticated;

drop policy if exists "Public can read active instruments" on public.bot_active_instruments;
create policy "Public can read active instruments"
  on public.bot_active_instruments for select
  to anon, authenticated
  using (true);

-- Add broker session caching column to bot_settings
alter table public.bot_settings
  add column if not exists angel_jwt_token text,
  add column if not exists angel_jwt_expires_at timestamptz,
  add column if not exists session_opening_baseline_at timestamptz,
  add column if not exists session_opening_atm_strike numeric(14, 4);

-- Scheduled daily pre-market sync at 08:30 AM IST (03:00 UTC) Mon-Fri
select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-premarket-sync-instruments';

select cron.schedule(
  'bot-premarket-sync-instruments',
  '0 3 * * 1-5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/bot-sync-instruments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'bot_anon_jwt' limit 1),
        (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
      )
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);
