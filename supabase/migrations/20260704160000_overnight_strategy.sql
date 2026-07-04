-- Overnight-hold strategy: the only setup that survived real-data validation.
-- 22-symbol pooled PF 1.238 (2015-22 daily), OOS test PF 1.27 (2022-26 intraday).
-- Buys a basket near the close (overnight-entry), sells at next open (overnight-exit).
-- eod-flatten is patched to skip these positions.

-- 1. Seed the strategy (starts in paper_live_small, enabled).
insert into public.bot_strategies (
  name, version, status, enabled, lifecycle_status,
  risk_multiplier, max_risk_multiplier, promotion_thresholds
)
values (
  'overnight_hold', 'v1', 'active', true, 'paper_live_small',
  1.0, 1.5,
  '{"shadow_min_outcomes":30,"shadow_min_profit_factor":1.10,"normal_min_live_trades":30,"normal_min_profit_factor":1.20,"reduced_profit_factor":1.00}'::jsonb
)
on conflict (name, version) do update set
  enabled = excluded.enabled,
  lifecycle_status = excluded.lifecycle_status,
  status = excluded.status,
  updated_at = now();

-- 2. Cron: entry near the close, exit at the open (times in UTC; IST = UTC+5:30).
--    Entry 15:24 IST = 09:54 UTC. Exit 09:17 IST = 03:47 UTC. Weekdays only.
select cron.unschedule(jobid) from cron.job where jobname = 'overnight-entry-daily';
select cron.schedule(
  'overnight-entry-daily',
  '54 9 * * 1-5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/overnight-entry',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'bot_anon_jwt' limit 1),
        (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
      )
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

select cron.unschedule(jobid) from cron.job where jobname = 'overnight-exit-daily';
select cron.schedule(
  'overnight-exit-daily',
  '47 3 * * 1-5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/overnight-exit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'bot_anon_jwt' limit 1),
        (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
      )
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
