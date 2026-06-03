alter table public.bot_settings
  add column if not exists nifty_current_ltp numeric(14, 4);
