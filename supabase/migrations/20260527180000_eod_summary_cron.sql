-- EOD summary cron: runs at 3:30 PM IST = 10:00 AM UTC, Mon–Fri
-- Separate from eod-flatten (3:15 PM) so the summary fires after
-- all positions are closed and the market has fully shut.

select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-eod-summary';

select cron.schedule(
  'bot-eod-summary',
  '0 10 * * 1-5',   -- 3:30 PM IST = 10:00 AM UTC, weekdays only
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url') || '/functions/v1/eod-summary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
