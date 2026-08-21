-- Schedule 09:00 AM IST Daily Pre-Flight Check for Options Dashboard & Trading Bot
-- 09:00 AM IST is 03:30 AM UTC (Mon-Fri)

select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-preflight-check';

select cron.schedule(
  'bot-preflight-check',
  '30 3 * * 1-5',  -- 09:00 AM IST (03:30 AM UTC) Mon-Fri
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/bot-preflight-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'bot_anon_jwt' limit 1),
        (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
      )
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);
