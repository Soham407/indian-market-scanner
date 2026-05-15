alter table public.instruments
  add column if not exists angel_one_token text unique,
  add column if not exists pdh_refreshed_at timestamptz;

comment on column public.instruments.angel_one_token is
  'Angel One SmartAPI symbolToken for NSE instruments. Resolved once via searchScrip and cached here.';

comment on column public.instruments.pdh_refreshed_at is
  'Timestamp of the last successful previous-day OHLC refresh. Used to guard against re-fetching within the same trading day.';

create index if not exists instruments_angel_one_token_idx
  on public.instruments (angel_one_token);
