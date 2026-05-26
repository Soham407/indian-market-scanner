create extension if not exists pgcrypto;

create or replace function public.bot_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.bot_strategies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_strategies_status_check check (status in ('active', 'inactive', 'archived')),
  constraint bot_strategies_name_version_key unique (name, version)
);

create table if not exists public.bot_strategy_parameters (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete cascade,
  name text not null,
  value numeric(14, 6) not null,
  min_value numeric(14, 6) not null,
  max_value numeric(14, 6) not null,
  is_tunable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_strategy_parameters_name_key unique (strategy_id, name),
  constraint bot_strategy_parameters_bounds_check check (
    min_value <= max_value
    and value >= min_value
    and value <= max_value
  )
);

create table if not exists public.bot_tuning_runs (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete cascade,
  run_at timestamptz not null default now(),
  score_function text not null,
  min_trades_threshold integer not null,
  best_parameter_set jsonb not null default '{}'::jsonb,
  score numeric(14, 6) not null,
  parameters_updated jsonb not null default '{}'::jsonb,
  rationale text not null,
  created_at timestamptz not null default now(),
  constraint bot_tuning_runs_min_trades_threshold_check check (min_trades_threshold > 0),
  constraint bot_tuning_runs_best_parameter_set_check check (jsonb_typeof(best_parameter_set) = 'object'),
  constraint bot_tuning_runs_parameters_updated_check check (jsonb_typeof(parameters_updated) = 'object')
);

create table if not exists public.bot_parameter_history (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete cascade,
  parameter_name text not null,
  old_value numeric(14, 6) not null,
  new_value numeric(14, 6) not null,
  rationale text not null,
  tuner_run_id uuid references public.bot_tuning_runs(id) on delete set null,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.bot_candles (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  timeframe text not null,
  open numeric(14, 4) not null,
  high numeric(14, 4) not null,
  low numeric(14, 4) not null,
  close numeric(14, 4) not null,
  volume numeric(18, 4) not null,
  candle_open_at timestamptz not null,
  source text not null default 'angel_one',
  created_at timestamptz not null default now(),
  constraint bot_candles_unique_key unique (instrument_id, timeframe, candle_open_at),
  constraint bot_candles_positive_prices check (
    open > 0 and high > 0 and low > 0 and close > 0
  ),
  constraint bot_candles_volume_non_negative check (volume >= 0),
  constraint bot_candles_ohlc_bounds check (
    high >= low
    and high >= open
    and high >= close
    and low <= open
    and low <= close
  )
);

create table if not exists public.bot_paper_trades (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete restrict,
  instrument_id uuid not null references public.instruments(id) on delete restrict,
  side text not null,
  entry_price numeric(14, 4) not null,
  entry_time timestamptz not null,
  entry_slippage_pct numeric(8, 5) not null,
  stop_loss_price numeric(14, 4) not null,
  target_price numeric(14, 4) not null,
  exit_price numeric(14, 4),
  exit_time timestamptz,
  exit_reason text,
  shares integer not null,
  gross_pnl numeric(14, 4),
  brokerage numeric(14, 4),
  statutory_charges numeric(14, 4),
  net_pnl numeric(14, 4),
  risk_amount numeric(14, 4) not null,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_paper_trades_side_check check (side in ('long', 'short')),
  constraint bot_paper_trades_status_check check (status in ('open', 'closed', 'frozen')),
  constraint bot_paper_trades_exit_reason_check check (
    exit_reason is null
    or exit_reason in ('target', 'stop', 'eod', 'manual', 'frozen')
  ),
  constraint bot_paper_trades_closed_fields_check check (
    (status = 'closed' and exit_price is not null and exit_time is not null and exit_reason is not null)
    or status <> 'closed'
  ),
  constraint bot_paper_trades_positive_values_check check (
    entry_price > 0
    and stop_loss_price > 0
    and target_price > 0
    and shares > 0
    and risk_amount >= 0
    and entry_slippage_pct >= 0
  )
);

create table if not exists public.bot_incidents (
  id uuid primary key default gen_random_uuid(),
  severity text not null,
  source text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint bot_incidents_severity_check check (severity in ('info', 'warn', 'critical'))
);

create index if not exists bot_candles_instrument_id_timeframe_candle_open_at_idx
  on public.bot_candles (instrument_id, timeframe, candle_open_at);

create index if not exists bot_paper_trades_status_opened_at_idx
  on public.bot_paper_trades (status, opened_at);

create index if not exists bot_incidents_severity_created_at_idx
  on public.bot_incidents (severity, created_at);

drop trigger if exists bot_strategies_set_updated_at on public.bot_strategies;
create trigger bot_strategies_set_updated_at
before update on public.bot_strategies
for each row execute function public.bot_set_updated_at();

drop trigger if exists bot_strategy_parameters_set_updated_at on public.bot_strategy_parameters;
create trigger bot_strategy_parameters_set_updated_at
before update on public.bot_strategy_parameters
for each row execute function public.bot_set_updated_at();

drop trigger if exists bot_paper_trades_set_updated_at on public.bot_paper_trades;
create trigger bot_paper_trades_set_updated_at
before update on public.bot_paper_trades
for each row execute function public.bot_set_updated_at();

alter table public.bot_settings disable row level security;
alter table public.bot_strategies disable row level security;
alter table public.bot_strategy_parameters disable row level security;
alter table public.bot_parameter_history disable row level security;
alter table public.bot_candles disable row level security;
alter table public.bot_paper_trades disable row level security;
alter table public.bot_tuning_runs disable row level security;
alter table public.bot_incidents disable row level security;

with seeded_strategy as (
  insert into public.bot_strategies (name, version, status)
  values ('orb_breakout', 'v1', 'active')
  on conflict (name, version)
  do update set
    status = excluded.status,
    updated_at = now()
  returning id
)
insert into public.bot_strategy_parameters (
  strategy_id,
  name,
  value,
  min_value,
  max_value,
  is_tunable
)
select
  seeded_strategy.id,
  seeded_parameters.name,
  seeded_parameters.value,
  seeded_parameters.min_value,
  seeded_parameters.max_value,
  true
from seeded_strategy
cross join (
  values
    ('range_minutes'::text, 15::numeric, 5::numeric, 60::numeric),
    ('volume_multiplier'::text, 1.5::numeric, 1.0::numeric, 5.0::numeric),
    ('target_multiplier'::text, 1.5::numeric, 0.5::numeric, 5.0::numeric)
) as seeded_parameters(name, value, min_value, max_value)
on conflict (strategy_id, name)
do update set
  value = excluded.value,
  min_value = excluded.min_value,
  max_value = excluded.max_value,
  is_tunable = excluded.is_tunable,
  updated_at = now();
