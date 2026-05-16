-- session_low: intraday session low written each minute from Angel One FULL quote.
-- Mirrors session_high — used by the PDL bounce signal (bullish trap detector).
alter table public.instruments
  add column if not exists session_low numeric;
