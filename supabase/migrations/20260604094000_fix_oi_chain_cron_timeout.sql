-- The bot-oi-chain edge function needs more than the default 5 s pg_net timeout:
-- it must authenticate with Angel One, fetch the full scrip master (large JSON),
-- batch-fetch FULL quotes for 100+ option tokens (multiple round-trips), and
-- insert rows.  Raise to 30 s so the function has room to complete.

select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-oi-chain-every-5-minutes';

select cron.schedule(
  'bot-oi-chain-every-5-minutes',
  '*/5 * * * 1-5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/bot-oi-chain',
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
