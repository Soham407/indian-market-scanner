alter table public.bot_strategies
  add column if not exists lifecycle_status text not null default 'research',
  add column if not exists enabled boolean not null default false,
  add column if not exists risk_multiplier numeric(8, 4) not null default 0.25,
  add column if not exists max_risk_multiplier numeric(8, 4) not null default 1.5,
  add column if not exists promotion_thresholds jsonb not null default '{}'::jsonb,
  add column if not exists last_reviewed_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bot_strategies_lifecycle_status_check'
      and conrelid = 'public.bot_strategies'::regclass
  ) then
    alter table public.bot_strategies
      add constraint bot_strategies_lifecycle_status_check
      check (lifecycle_status in ('research', 'shadow', 'paper_live_small', 'paper_live_normal', 'reduced', 'disabled'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'bot_strategies_risk_multiplier_cap_check'
      and conrelid = 'public.bot_strategies'::regclass
  ) then
    alter table public.bot_strategies
      add constraint bot_strategies_risk_multiplier_cap_check
      check (
        risk_multiplier >= 0
        and risk_multiplier <= 1.5
        and max_risk_multiplier >= 0
        and max_risk_multiplier <= 1.5
        and risk_multiplier <= max_risk_multiplier
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'bot_strategies_promotion_thresholds_object_check'
      and conrelid = 'public.bot_strategies'::regclass
  ) then
    alter table public.bot_strategies
      add constraint bot_strategies_promotion_thresholds_object_check
      check (jsonb_typeof(promotion_thresholds) = 'object');
  end if;
end $$;

-- These are new managed bot tables; this migration expects no manually-created
-- partial versions of them to already exist.
create table if not exists public.bot_trade_signals (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete restrict,
  source text not null,
  instrument_id uuid not null references public.instruments(id) on delete restrict,
  side text not null,
  signal_time timestamptz not null default now(),
  trigger_price numeric(14, 4) not null,
  stop_loss_price numeric(14, 4) not null,
  target_price numeric(14, 4) not null,
  timeframe text not null default '1m',
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  rejection_reason text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_trade_signals_side_check check (side in ('long', 'short')),
  constraint bot_trade_signals_status_check check (status in ('pending', 'shadow_tracked', 'accepted', 'rejected', 'expired')),
  constraint bot_trade_signals_positive_prices_check check (
    trigger_price > 0 and stop_loss_price > 0 and target_price > 0
  ),
  constraint bot_trade_signals_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.bot_signal_outcomes (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.bot_trade_signals(id) on delete cascade,
  paper_trade_id uuid references public.bot_paper_trades(id) on delete set null,
  mode text not null,
  entry_price numeric(14, 4) not null,
  exit_price numeric(14, 4),
  exit_reason text,
  gross_pnl numeric(14, 4),
  net_pnl numeric(14, 4),
  r_multiple numeric(14, 6),
  max_favorable_excursion numeric(14, 4),
  max_adverse_excursion numeric(14, 4),
  duration_minutes integer,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_signal_outcomes_mode_check check (mode in ('shadow', 'paper_live')),
  constraint bot_signal_outcomes_status_check check (status in ('open', 'closed')),
  constraint bot_signal_outcomes_positive_entry_check check (entry_price > 0),
  constraint bot_signal_outcomes_duration_check check (duration_minutes is null or duration_minutes >= 0)
);

create table if not exists public.bot_strategy_reviews (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete cascade,
  reviewed_at timestamptz not null default now(),
  window_start timestamptz not null,
  window_end timestamptz not null,
  sample_count integer not null,
  profit_factor numeric(14, 6),
  win_rate numeric(8, 4),
  average_r numeric(14, 6),
  max_drawdown numeric(14, 4),
  rejection_rate numeric(8, 4),
  previous_status text not null,
  new_status text not null,
  previous_risk_multiplier numeric(8, 4),
  new_risk_multiplier numeric(8, 4),
  decision text not null,
  rationale text not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint bot_strategy_reviews_sample_count_check check (sample_count >= 0),
  constraint bot_strategy_reviews_metrics_object_check check (jsonb_typeof(metrics) = 'object')
);

create index if not exists bot_trade_signals_status_signal_time_idx
  on public.bot_trade_signals (status, signal_time);

create index if not exists bot_trade_signals_strategy_instrument_time_idx
  on public.bot_trade_signals (strategy_id, instrument_id, signal_time);

create index if not exists bot_signal_outcomes_signal_id_idx
  on public.bot_signal_outcomes (signal_id);

create index if not exists bot_signal_outcomes_trade_id_idx
  on public.bot_signal_outcomes (paper_trade_id);

create index if not exists bot_strategy_reviews_strategy_reviewed_idx
  on public.bot_strategy_reviews (strategy_id, reviewed_at desc);

drop trigger if exists bot_trade_signals_set_updated_at on public.bot_trade_signals;
create trigger bot_trade_signals_set_updated_at
before update on public.bot_trade_signals
for each row execute function public.bot_set_updated_at();

drop trigger if exists bot_signal_outcomes_set_updated_at on public.bot_signal_outcomes;
create trigger bot_signal_outcomes_set_updated_at
before update on public.bot_signal_outcomes
for each row execute function public.bot_set_updated_at();

alter table public.bot_trade_signals enable row level security;
alter table public.bot_signal_outcomes enable row level security;
alter table public.bot_strategy_reviews enable row level security;

grant select on public.bot_trade_signals to authenticated;
grant select on public.bot_signal_outcomes to authenticated;
grant select on public.bot_strategy_reviews to authenticated;

drop policy if exists "Authenticated users can read bot trade signals" on public.bot_trade_signals;
create policy "Authenticated users can read bot trade signals"
  on public.bot_trade_signals for select to authenticated using (true);

drop policy if exists "Authenticated users can read bot signal outcomes" on public.bot_signal_outcomes;
create policy "Authenticated users can read bot signal outcomes"
  on public.bot_signal_outcomes for select to authenticated using (true);

drop policy if exists "Authenticated users can read bot strategy reviews" on public.bot_strategy_reviews;
create policy "Authenticated users can read bot strategy reviews"
  on public.bot_strategy_reviews for select to authenticated using (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.bot_trade_signals;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.bot_signal_outcomes;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.bot_strategy_reviews;
  exception when duplicate_object then null;
  end;
end $$;

update public.bot_strategies
set
  enabled = true,
  lifecycle_status = case
    when lifecycle_status = 'research' then 'paper_live_small'
    else lifecycle_status
  end,
  risk_multiplier = least(greatest(risk_multiplier, 0.25), 1.5),
  max_risk_multiplier = least(max_risk_multiplier, 1.5),
  promotion_thresholds = promotion_thresholds || jsonb_build_object(
    'shadow_min_outcomes', 30,
    'shadow_min_profit_factor', 1.10,
    'normal_min_live_trades', 30,
    'normal_min_profit_factor', 1.20,
    'reduced_profit_factor', 1.00
  )
where name = 'orb_breakout';
