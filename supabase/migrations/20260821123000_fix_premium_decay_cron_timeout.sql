-- The bot-premium-decay edge function needs more than the default 5 s pg_net timeout:
-- it must authenticate with Angel One, fetch the scrip master, batch-fetch option LTPs,
-- and insert baseline/decay points. Raise timeout to 30 s.

select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-premium-decay-every-minute';

select cron.schedule(
  'bot-premium-decay-every-minute',
  '* * * * 1-5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/bot-premium-decay',
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
