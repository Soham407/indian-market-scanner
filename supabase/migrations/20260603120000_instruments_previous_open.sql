alter table public.instruments
  add column if not exists previous_open numeric(14, 4);

-- Store NIFTY index (token 99926000) yesterday OHLC in bot_settings so the
-- options dashboard can display Open / High / Low / Close / Mid without needing
-- the index in the equities instruments table.
alter table public.bot_settings
  add column if not exists nifty_previous_open  numeric(14, 4),
  add column if not exists nifty_previous_high  numeric(14, 4),
  add column if not exists nifty_previous_low   numeric(14, 4),
  add column if not exists nifty_previous_close numeric(14, 4),
  add column if not exists nifty_previous_date  date;
