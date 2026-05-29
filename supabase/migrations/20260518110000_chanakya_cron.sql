-- Chanakya Bullish Scanner cron jobs.
-- Runs twice daily (IST):
--   07:00 IST = 01:30 UTC  → pre-market, uses previous day's close
--   16:30 IST = 11:00 UTC  → post-market, uses today's close

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'market-sniper-chanakya-pre-market',
  'market-sniper-chanakya-post-market'
);

select cron.schedule(
  'market-sniper-chanakya-pre-market',
  '30 1 * * 1-5',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/scan-chanakya',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

select cron.schedule(
  'market-sniper-chanakya-post-market',
  '0 11 * * 1-5',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/scan-chanakya',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
