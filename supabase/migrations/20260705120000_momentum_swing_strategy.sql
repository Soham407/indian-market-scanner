-- Momentum swing strategy (PAPER): the validated ₹50k-accessible edge.
-- Survivorship-free OOS PF 1.3-2.6, held in the 2023-25 AI-era regime.
-- Buys top-5 NSE names by 126d return, rebalances monthly. Paper only.

insert into public.bot_strategies (
  name, version, status, enabled, lifecycle_status,
  risk_multiplier, max_risk_multiplier, promotion_thresholds
)
values (
  'momentum_swing', 'v1', 'active', true, 'paper_live_small',
  1.0, 1.5,
  '{"shadow_min_outcomes":20,"shadow_min_profit_factor":1.10,"normal_min_live_trades":30,"normal_min_profit_factor":1.20,"reduced_profit_factor":1.00}'::jsonb
)
on conflict (name, version) do update set
  enabled = excluded.enabled, lifecycle_status = excluded.lifecycle_status,
  status = excluded.status, updated_at = now();

-- Monthly rebalance: 1st of month, 05:30 UTC (11:00 IST). Yahoo close-based, so
-- weekends/holidays just use the latest trading close.
select cron.unschedule(jobid) from cron.job where jobname = 'momentum-rebalance-monthly';
select cron.schedule(
  'momentum-rebalance-monthly',
  '30 5 1 * *',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/momentum-rebalance',
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
