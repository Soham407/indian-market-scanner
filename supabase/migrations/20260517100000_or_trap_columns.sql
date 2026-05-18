-- Opening Range (OR) columns for the OR trap signal (10:15–13:30 IST).
-- or_high / or_low: session high and low captured during 09:15–10:14 IST,
--   then frozen so scan-alerts can detect post-OR breakout failures.
-- or_date: IST date string guards against yesterday's stale OR being used.
alter table public.instruments
  add column if not exists or_high numeric,
  add column if not exists or_low  numeric,
  add column if not exists or_date text;

comment on column public.instruments.or_high is
  'Opening range high (session high frozen at 10:15 IST). Written each minute during 09:15–10:14; not written after 10:15 so the value is stable for the OR trap signal.';
comment on column public.instruments.or_low is
  'Opening range low (session low frozen at 10:15 IST). Mirror of or_high.';
comment on column public.instruments.or_date is
  'IST date string (YYYY-MM-DD) for the OR snapshot. scan-alerts checks or_date === today before using or_high / or_low.';
