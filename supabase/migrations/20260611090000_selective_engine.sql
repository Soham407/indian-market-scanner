-- Cost-aware selective engine (spec docs/superpowers/specs/2026-06-10-*.md).
-- Schema for: breakeven stop tracking, time_stop exit reason, NIFTY opening
-- range cache, watchdog dedup, hard selectivity caps, and real-money
-- promotion gates as config.

-- Breakeven tracking on open trades (check-exits moves stop to entry at +1R)
alter table public.bot_paper_trades
  add column if not exists stop_moved_to_breakeven boolean not null default false;

-- Allow the new time_stop exit reason (preserving existing manual/frozen values)
alter table public.bot_paper_trades
  drop constraint if exists bot_paper_trades_exit_reason_check;

alter table public.bot_paper_trades
  add constraint bot_paper_trades_exit_reason_check
  check (
    exit_reason is null
    or exit_reason in ('target', 'stop', 'eod', 'manual', 'frozen', 'time_stop')
  );

-- NIFTY opening range cache (computed once per day from premium-decay spot
-- samples, read-only) + watchdog once-per-day dedup
alter table public.bot_settings
  add column if not exists nifty_or_high numeric,
  add column if not exists nifty_or_low numeric,
  add column if not exists nifty_or_date date,
  add column if not exists watchdog_alerted_date date;

-- Hard selectivity caps: 5 trades/day, 3 concurrent
-- (bot_settings_executor_limits_check requires > 0, satisfied)
update public.bot_settings
set max_daily_trades = 5,
    max_concurrent_positions = 3
where id = 1;

-- Fewer, bigger: at 0.25× (₹250 risk) the ₹40+ round-trip charges are ~11% of
-- a 1.5R expected win and the economics gate would reject every trade. 1.0×
-- (₹1,000 = 1% of ₹1L paper capital) brings charges under 3% of expected win.
-- The daily ₹3,000 breaker still caps the day at 3 full-risk losers.
update public.bot_strategies
set risk_multiplier = 1.0
where lifecycle_status in ('paper_live_small', 'paper_live_normal', 'reduced')
  and risk_multiplier < 1.0;

-- Real-money promotion gates: the documented bar before any live capital.
-- No code path wires real money; these are config-as-policy.
update public.bot_strategies
set promotion_thresholds = promotion_thresholds || '{
  "real_money_min_trades": 60,
  "real_money_min_profit_factor": 1.3,
  "real_money_max_drawdown_pct": 5,
  "real_money_min_weeks": 4
}'::jsonb;
