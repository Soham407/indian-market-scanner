-- Fix scan-alerts cron to hardcode the Vercel URL instead of using vault secrets
-- This allows the cron to run without needing vault permissions

select cron.unschedule(jobid)
from cron.job
where jobname = 'market-sniper-scan-alerts';

select cron.schedule(
  'market-sniper-scan-alerts',
  '*/5 3-10 * * 1-5',
  $$
  select net.http_post(
    url := 'https://indian-market-scanner.vercel.app/functions/v1/scan-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_JUCxMDeCTv-b8QKu3bRHHA_wpLs6dLY'
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

-- Also fix refresh-prices
select cron.unschedule(jobid)
from cron.job
where jobname = 'market-sniper-refresh-prices';

select cron.schedule(
  'market-sniper-refresh-prices',
  '* 3-10 * * 1-5',
  $$
  select net.http_post(
    url := 'https://indian-market-scanner.vercel.app/functions/v1/refresh-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_JUCxMDeCTv-b8QKu3bRHHA_wpLs6dLY'
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
