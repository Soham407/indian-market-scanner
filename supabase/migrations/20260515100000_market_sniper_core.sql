create extension if not exists pgcrypto;

create type public.alert_direction as enum ('bullish', 'bearish');
create type public.alert_status as enum ('active', 'expired', 'invalidated');
create type public.shadow_trade_side as enum ('long', 'short');
create type public.shadow_trade_status as enum ('open', 'closed', 'cancelled');

create table public.instruments (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  exchange text not null default 'NSE',
  name text not null,
  sector text,
  tick_size numeric(12, 4) not null default 0.05,
  lot_size integer not null default 1,
  last_price numeric(14, 4),
  previous_close numeric(14, 4),
  previous_day_high numeric(14, 4),
  previous_day_low numeric(14, 4),
  vwap numeric(14, 4),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint instruments_symbol_exchange_key unique (symbol, exchange),
  constraint instruments_positive_lot_size check (lot_size > 0),
  constraint instruments_positive_tick_size check (tick_size > 0)
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  alert_type text not null default 'liquidity_trap',
  direction public.alert_direction not null,
  title text not null,
  thesis text not null,
  trigger_price numeric(14, 4) not null,
  current_price numeric(14, 4) not null,
  swept_level numeric(14, 4) not null,
  swept_level_name text not null,
  volume_multiplier numeric(8, 2) not null,
  conviction_score smallint not null,
  score_factors jsonb not null default '[]'::jsonb,
  timeframe_alignment jsonb not null default '{}'::jsonb,
  market_session text not null default 'regular',
  status public.alert_status not null default 'active',
  detected_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alerts_conviction_score_range check (conviction_score between 0 and 100),
  constraint alerts_positive_volume_multiplier check (volume_multiplier > 0),
  constraint alerts_score_factors_array check (jsonb_typeof(score_factors) = 'array'),
  constraint alerts_timeframe_alignment_object check (jsonb_typeof(timeframe_alignment) = 'object')
);

create table public.price_marks (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  price numeric(14, 4) not null,
  source text not null default 'edge_function',
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint price_marks_positive_price check (price > 0)
);

create table public.shadow_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_id uuid references public.alerts(id) on delete set null,
  instrument_id uuid not null references public.instruments(id) on delete restrict,
  side public.shadow_trade_side not null,
  quantity integer not null default 1,
  entry_price numeric(14, 4) not null,
  current_price numeric(14, 4) not null,
  exit_price numeric(14, 4),
  entry_reason text not null,
  exit_reason text,
  status public.shadow_trade_status not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shadow_trades_positive_quantity check (quantity > 0),
  constraint shadow_trades_positive_entry_price check (entry_price > 0),
  constraint shadow_trades_positive_current_price check (current_price > 0),
  constraint shadow_trades_exit_price_when_closed check (
    (status = 'closed' and exit_price is not null and closed_at is not null)
    or (status <> 'closed')
  )
);

create index instruments_exchange_symbol_idx on public.instruments (exchange, symbol);
create index alerts_status_detected_at_idx on public.alerts (status, detected_at desc);
create index alerts_instrument_detected_at_idx on public.alerts (instrument_id, detected_at desc);
create index price_marks_instrument_observed_at_idx on public.price_marks (instrument_id, observed_at desc);
create index shadow_trades_user_status_opened_at_idx on public.shadow_trades (user_id, status, opened_at desc);
create index shadow_trades_alert_id_idx on public.shadow_trades (alert_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger instruments_set_updated_at
before update on public.instruments
for each row execute function public.set_updated_at();

create trigger alerts_set_updated_at
before update on public.alerts
for each row execute function public.set_updated_at();

create trigger shadow_trades_set_updated_at
before update on public.shadow_trades
for each row execute function public.set_updated_at();

create or replace view public.alert_feed
with (security_invoker = true)
as
select
  a.id,
  a.instrument_id,
  i.symbol,
  i.exchange,
  i.name as instrument_name,
  a.alert_type,
  a.direction,
  a.title,
  a.thesis,
  a.trigger_price,
  a.current_price,
  a.swept_level,
  a.swept_level_name,
  a.volume_multiplier,
  a.conviction_score,
  a.score_factors,
  a.timeframe_alignment,
  a.market_session,
  a.status,
  a.detected_at,
  a.expires_at,
  a.created_at,
  a.updated_at
from public.alerts a
join public.instruments i on i.id = a.instrument_id;

create or replace view public.shadow_trade_positions
with (security_invoker = true)
as
select
  st.id,
  st.user_id,
  st.alert_id,
  st.instrument_id,
  i.symbol,
  i.exchange,
  i.name as instrument_name,
  st.side,
  st.quantity,
  st.entry_price,
  st.current_price,
  st.exit_price,
  st.entry_reason,
  st.exit_reason,
  st.status,
  st.opened_at,
  st.closed_at,
  case
    when st.side = 'long' then (coalesce(st.exit_price, st.current_price) - st.entry_price) * st.quantity
    else (st.entry_price - coalesce(st.exit_price, st.current_price)) * st.quantity
  end as unrealized_pnl,
  case
    when st.side = 'long' then ((coalesce(st.exit_price, st.current_price) - st.entry_price) / st.entry_price) * 100
    else ((st.entry_price - coalesce(st.exit_price, st.current_price)) / st.entry_price) * 100
  end as pnl_percent,
  st.created_at,
  st.updated_at
from public.shadow_trades st
join public.instruments i on i.id = st.instrument_id;

alter table public.instruments enable row level security;
alter table public.alerts enable row level security;
alter table public.price_marks enable row level security;
alter table public.shadow_trades enable row level security;

create policy "Authenticated users can read instruments"
on public.instruments for select
to authenticated
using (true);

create policy "Authenticated users can read alerts"
on public.alerts for select
to authenticated
using (true);

create policy "Authenticated users can read price marks"
on public.price_marks for select
to authenticated
using (true);

create policy "Users can read their shadow trades"
on public.shadow_trades for select
to authenticated
using (user_id = auth.uid());

create or replace function public.open_shadow_trade(
  p_alert_id uuid,
  p_quantity integer default 1
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert public.alerts%rowtype;
  v_side public.shadow_trade_side;
  v_trade_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be positive';
  end if;

  select *
  into v_alert
  from public.alerts
  where id = p_alert_id
    and status = 'active';

  if not found then
    raise exception 'Active alert not found';
  end if;

  v_side := case
    when v_alert.direction = 'bearish' then 'short'::public.shadow_trade_side
    else 'long'::public.shadow_trade_side
  end;

  insert into public.shadow_trades (
    user_id,
    alert_id,
    instrument_id,
    side,
    quantity,
    entry_price,
    current_price,
    entry_reason
  )
  values (
    auth.uid(),
    v_alert.id,
    v_alert.instrument_id,
    v_side,
    p_quantity,
    v_alert.current_price,
    v_alert.current_price,
    'Liquidity Trap Alert shadow trade'
  )
  returning id into v_trade_id;

  return v_trade_id;
end;
$$;

create or replace function public.close_shadow_trade(p_trade_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.shadow_trades
  set
    status = 'closed',
    exit_price = current_price,
    closed_at = now(),
    exit_reason = 'Manual close'
  where id = p_trade_id
    and user_id = auth.uid()
    and status = 'open'
  returning id into v_trade_id;

  if v_trade_id is null then
    raise exception 'Open shadow trade not found';
  end if;

  return v_trade_id;
end;
$$;

revoke all on public.instruments from anon, authenticated;
revoke all on public.alerts from anon, authenticated;
revoke all on public.price_marks from anon, authenticated;
revoke all on public.shadow_trades from anon, authenticated;
revoke all on public.alert_feed from anon, authenticated;
revoke all on public.shadow_trade_positions from anon, authenticated;
revoke all on function public.open_shadow_trade(uuid, integer) from public;
revoke all on function public.close_shadow_trade(uuid) from public;

grant select on public.instruments to authenticated;
grant select on public.alerts to authenticated;
grant select on public.price_marks to authenticated;
grant select on public.alert_feed to authenticated;
grant select on public.shadow_trade_positions to authenticated;
grant execute on function public.open_shadow_trade(uuid, integer) to authenticated;
grant execute on function public.close_shadow_trade(uuid) to authenticated;

insert into public.instruments (symbol, exchange, name, sector, last_price, previous_close, previous_day_high, previous_day_low, vwap)
values
  ('RELIANCE', 'NSE', 'Reliance Industries', 'Energy', 2924.50, 2898.20, 2919.00, 2864.10, 2907.85),
  ('HDFCBANK', 'NSE', 'HDFC Bank', 'Financials', 1548.30, 1534.70, 1544.00, 1518.25, 1538.40),
  ('INFY', 'NSE', 'Infosys', 'Information Technology', 1482.75, 1497.20, 1502.10, 1474.50, 1488.15)
on conflict (symbol, exchange) do update set
  name = excluded.name,
  sector = excluded.sector,
  last_price = excluded.last_price,
  previous_close = excluded.previous_close,
  previous_day_high = excluded.previous_day_high,
  previous_day_low = excluded.previous_day_low,
  vwap = excluded.vwap,
  updated_at = now();

insert into public.alerts (
  instrument_id,
  direction,
  title,
  thesis,
  trigger_price,
  current_price,
  swept_level,
  swept_level_name,
  volume_multiplier,
  conviction_score,
  score_factors,
  timeframe_alignment,
  expires_at
)
select
  i.id,
  'bearish'::public.alert_direction,
  i.symbol || ' swept previous day high',
  'Price swept previous day high on elevated volume and faded back toward VWAP.',
  i.previous_day_high,
  i.last_price,
  i.previous_day_high,
  'Previous Day High',
  1.74,
  82,
  '[{"name":"Daily trend","score":24,"state":"aligned"},{"name":"VWAP distance","score":18,"state":"extended"},{"name":"Volume expansion","score":22,"state":"confirmed"},{"name":"Level quality","score":18,"state":"clean sweep"}]'::jsonb,
  '{"daily":"uptrend","intraday":"failed breakout","vwap":"extended above"}'::jsonb,
  now() + interval '1 day'
from public.instruments i
where i.symbol = 'RELIANCE';

do $$
begin
  alter publication supabase_realtime add table public.alerts;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.shadow_trades;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
