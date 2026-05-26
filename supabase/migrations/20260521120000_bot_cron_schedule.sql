-- Paper Trading Bot cron schedule
-- Orchestrates the daily trading lifecycle

-- Clean up any existing bot cron jobs
select cron.unschedule(jobid)
from cron.job
where jobname like 'bot-%';

-- 9:15 AM IST: ORB Scanner + Paper Executor
-- Builds opening range and detects breakouts during 9:15-9:30 window
-- Then monitors and enters trades during 9:30-15:30 window
select cron.schedule(
  'bot-orb-scanner',
  '*/5 3,4,5,6,7,8,9 * * 1-5',  -- Every 5 minutes, 9:15-15:30 IST (3:45-10:00 UTC)
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/orb-scanner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

-- 9:30 AM - 3:30 PM IST: Exit Handler
-- Checks for stop loss and target hits every minute
select cron.schedule(
  'bot-check-exits',
  '* 4,5,6,7,8,9 * * 1-5',  -- Every minute, 9:30-15:30 IST (4:00-10:00 UTC)
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/check-exits',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

-- 3:15 PM IST: EOD Flatten + Circuit Breaker
-- Closes all open positions at market close and triggers circuit breaker if needed
select cron.schedule(
  'bot-eod-flatten',
  '45 9 * * 1-5',  -- 3:15 PM IST = 9:45 AM UTC
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/eod-flatten',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

-- 9:15 AM - 3:30 PM IST: Health Check + Heartbeat
-- Monitors data freshness and sends heartbeat every 15 minutes
select cron.schedule(
  'bot-health-check',
  '*/15 3,4,5,6,7,8,9 * * 1-5',  -- Every 15 minutes, 9:15-15:30 IST (3:45-10:00 UTC)
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/bot-health-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
