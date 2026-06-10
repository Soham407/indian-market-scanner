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

-- Real-money promotion gates: the documented bar before any live capital.
-- No code path wires real money; these are config-as-policy.
update public.bot_strategies
set promotion_thresholds = promotion_thresholds || '{
  "real_money_min_trades": 60,
  "real_money_min_profit_factor": 1.3,
  "real_money_max_drawdown_pct": 5,
  "real_money_min_weeks": 4
}'::jsonb;
