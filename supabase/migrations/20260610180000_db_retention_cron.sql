-- Nightly retention to keep the free-tier database small. The DB had grown to
-- 324 MB of 500 MB, almost entirely time-series the bot never reads back:
-- bot_candles had no retention at all (143 MB), price_marks kept 7 days
-- (73 MB), and pg_cron / pg_net logs accumulated unbounded (81 MB).
--
-- The bot only reads today's candles (opening range + latest close); quant
-- research uses local parquet files, not this DB. Options-dashboard tables
-- (bot_premium_decay_*, bot_nifty_oi_chain) are intentionally NOT touched —
-- they have their own retention (bot_purge_expired_premium_decay_points).
--
-- Runs at 19:00 UTC (00:30 IST), well outside market hours.

select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-db-retention';

select cron.schedule(
  'bot-db-retention',
  '0 19 * * *',
  $$
  delete from public.bot_candles where candle_open_at < now() - interval '3 days';
  delete from public.price_marks where created_at < now() - interval '2 days';
  delete from cron.job_run_details where start_time < now() - interval '2 days';
  $$
);

-- The old price-marks-retention job kept 7 days; superseded by the job above.
select cron.unschedule(jobid)
from cron.job
where jobname = 'price-marks-retention';
