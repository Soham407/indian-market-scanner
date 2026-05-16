-- Session OHLC columns for intraday trap signal detection.
-- session_high / session_volume: written each minute during market hours from
--   the Angel One FULL quote. Automatically represents the current day's data
--   because session_date is co-written and checked in scan-alerts.
-- session_date: IST date string ('YYYY-MM-DD') that guards against stale
--   session_high from the previous session being used as a trigger.
-- prev_day_volume: previous session's total volume, written during pre-market
--   OHLC refresh. Used to compute a real volume-expansion ratio at scan time.
alter table public.instruments
  add column if not exists session_high      numeric,
  add column if not exists session_volume    bigint,
  add column if not exists session_date      text,
  add column if not exists prev_day_volume   bigint;
