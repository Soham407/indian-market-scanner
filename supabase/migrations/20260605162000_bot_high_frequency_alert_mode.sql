alter table public.bot_settings
  add column if not exists max_concurrent_positions integer not null default 20,
  add column if not exists max_daily_trades integer not null default 100,
  add column if not exists signal_batch_limit integer not null default 100;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bot_settings_executor_limits_check'
      and conrelid = 'public.bot_settings'::regclass
  ) then
    alter table public.bot_settings
      add constraint bot_settings_executor_limits_check
      check (
        max_concurrent_positions > 0
        and max_concurrent_positions <= 100
        and max_daily_trades > 0
        and max_daily_trades <= 500
        and signal_batch_limit > 0
        and signal_batch_limit <= 500
      );
  end if;
end $$;

update public.bot_settings
set
  max_concurrent_positions = greatest(max_concurrent_positions, 20),
  max_daily_trades = greatest(max_daily_trades, 100),
  signal_batch_limit = greatest(signal_batch_limit, 100)
where id = 1;

insert into public.bot_strategies (
  name,
  version,
  status,
  enabled,
  lifecycle_status,
  risk_multiplier,
  max_risk_multiplier,
  promotion_thresholds
)
values
  ('pdh_trap', 'v1', 'active', true, 'paper_live_small', 0.25, 1.5, '{"shadow_min_outcomes":30,"shadow_min_profit_factor":1.10,"normal_min_live_trades":30,"normal_min_profit_factor":1.20,"reduced_profit_factor":1.00}'::jsonb),
  ('pdl_bounce', 'v1', 'active', true, 'paper_live_small', 0.25, 1.5, '{"shadow_min_outcomes":30,"shadow_min_profit_factor":1.10,"normal_min_live_trades":30,"normal_min_profit_factor":1.20,"reduced_profit_factor":1.00}'::jsonb),
  ('or_trap', 'v1', 'active', true, 'paper_live_small', 0.25, 1.5, '{"shadow_min_outcomes":30,"shadow_min_profit_factor":1.10,"normal_min_live_trades":30,"normal_min_profit_factor":1.20,"reduced_profit_factor":1.00}'::jsonb),
  ('or_breakout', 'v1', 'active', true, 'paper_live_small', 0.25, 1.5, '{"shadow_min_outcomes":30,"shadow_min_profit_factor":1.10,"normal_min_live_trades":30,"normal_min_profit_factor":1.20,"reduced_profit_factor":1.00}'::jsonb),
  ('chanakya_bullish', 'v1', 'active', true, 'paper_live_small', 0.25, 1.5, '{"shadow_min_outcomes":30,"shadow_min_profit_factor":1.10,"normal_min_live_trades":30,"normal_min_profit_factor":1.20,"reduced_profit_factor":1.00}'::jsonb)
on conflict (name, version)
do update set
  status = excluded.status,
  enabled = excluded.enabled,
  lifecycle_status = excluded.lifecycle_status,
  risk_multiplier = least(excluded.risk_multiplier, 1.5),
  max_risk_multiplier = least(excluded.max_risk_multiplier, 1.5),
  promotion_thresholds = public.bot_strategies.promotion_thresholds || excluded.promotion_thresholds,
  updated_at = now();
