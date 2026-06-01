create schema if not exists extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

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
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
