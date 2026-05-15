select cron.unschedule(jobid)
from cron.job
where jobname in (
  'market-sniper-scan-alerts',
  'market-sniper-refresh-prices'
);

select cron.schedule(
  'market-sniper-refresh-prices',
  '* 3-10 * * 1-5',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/refresh-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

select cron.schedule(
  'market-sniper-scan-alerts',
  '*/5 3-10 * * 1-5',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/scan-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
