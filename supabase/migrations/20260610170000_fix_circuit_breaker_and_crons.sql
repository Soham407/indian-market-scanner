-- Repair the trading pipeline after the 2026-06-09 regressions.
--
-- 1. The scan-alerts / refresh-prices crons were repointed at the Vercel app
--    (https://indian-market-scanner.vercel.app/functions/v1/...) which returns
--    HTTP 405 — edge functions live on the Supabase project URL. The vault
--    secrets the other bot crons use exist and work, so use the same pattern.
-- 2. The circuit breaker tripped on 2026-06-05 (daily loss ₹-3,068) and set
--    bot_settings.trading_enabled = false with no working reset path: the
--    dashboards read/write bot_config, which no edge function reads.
--    Add a tripped-at timestamp so the breaker can auto-reset next trading
--    day, an RPC the dashboards can call (RLS only grants SELECT), and a
--    one-time reset of the stale flag.

-- ─── 1. Fix scan-alerts cron ──────────────────────────────────────────────────

select cron.unschedule(jobid)
from cron.job
where jobname = 'market-sniper-scan-alerts';

select cron.schedule(
  'market-sniper-scan-alerts',
  '*/5 3-10 * * 1-5',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1) || '/functions/v1/scan-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

-- ─── 2. Fix refresh-prices cron ───────────────────────────────────────────────

select cron.unschedule(jobid)
from cron.job
where jobname = 'market-sniper-refresh-prices';

select cron.schedule(
  'market-sniper-refresh-prices',
  '* 3-10 * * 1-5',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1) || '/functions/v1/refresh-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

-- ─── 3. Circuit breaker trip timestamp ───────────────────────────────────────
-- Distinguishes a breaker-caused pause (auto-resets next trading day) from a
-- manual kill switch (stays off until re-enabled). bot_settings.updated_at is
-- useless for this: the heartbeat touches the row every minute.

alter table public.bot_settings
  add column if not exists circuit_breaker_tripped_at timestamptz;

-- ─── 4. Dashboard kill-switch RPC ────────────────────────────────────────────
-- Dashboards only have SELECT on bot_settings, so the toggle goes through a
-- security-definer RPC that keeps bot_settings (the gate the bot reads) and
-- bot_config (legacy table the dashboards display) in sync.

create or replace function public.bot_set_trading(p_enabled boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'authenticated' and auth.role() <> 'service_role' then
    raise exception 'not allowed';
  end if;

  update public.bot_settings
  set trading_enabled = p_enabled,
      kill_switch_reason = case when p_enabled then null else coalesce(p_reason, 'Manual kill switch') end,
      circuit_breaker_tripped_at = case when p_enabled then null else circuit_breaker_tripped_at end
  where id = 1;

  update public.bot_config
  set trading_enabled = p_enabled,
      circuit_breaker_triggered_at = case when p_enabled then null else circuit_breaker_triggered_at end,
      updated_at = now()
  where id = 1;
end;
$$;

revoke all on function public.bot_set_trading(boolean, text) from public, anon;
grant execute on function public.bot_set_trading(boolean, text) to authenticated, service_role;

-- ─── 5. One-time repair: clear the stale 2026-06-05 circuit breaker ──────────

update public.bot_settings
set trading_enabled = true,
    kill_switch_reason = null,
    circuit_breaker_tripped_at = null
where id = 1
  and trading_enabled = false
  and kill_switch_reason like 'Daily loss%';

update public.bot_config
set trading_enabled = true,
    circuit_breaker_triggered_at = null,
    updated_at = now()
where id = 1;
