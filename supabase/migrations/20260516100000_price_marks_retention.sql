-- Retain only the last 7 days of price_marks to prevent unbounded table growth.
-- Runs daily at 02:00 IST (20:30 UTC previous day) via pg_cron.
select cron.schedule(
  'price-marks-retention',
  '30 20 * * *',
  $$
    delete from public.price_marks
    where created_at < now() - interval '7 days';
  $$
);
