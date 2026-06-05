select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-signal-executor-every-minute';

select cron.schedule(
  'bot-signal-executor-every-minute',
  '* 4,5,6,7,8,9 * * 1-5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/bot-signal-executor',
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
