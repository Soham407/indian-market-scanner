# Automatic Strategy Promotion Engine

**Date:** 2026-06-05  
**Scope:** Auto paper-trading bot backend only  
**Status:** Approved for implementation planning

## Purpose

Build a paper-only strategy promotion system that can add, test, promote, reduce, or disable trading patterns automatically after measurable criteria are met.

The system must keep one execution path for all strategies:

```text
pattern detector -> bot_trade_signals -> bot-signal-executor -> bot_paper_trades -> exits/outcomes -> bot-feedback-run
```

This keeps ORB, future Market Sniper-derived patterns, and any later strategy under the same validation, slippage, risk, and kill-switch rules.

## Non-Goals

- Do not modify the `bot/` options dashboard that is already with the client for testing.
- Do not create real-money order execution.
- Do not add a Node worker, Railway service, DigitalOcean worker, or WebSocket execution service.
- Do not let pattern code insert directly into `bot_paper_trades`.
- Do not remove or weaken the `bot_settings.trading_enabled` kill switch.
- Do not allow any risk multiplier above `1.5`.

## Strategy Lifecycle

Strategies move through a measured lifecycle:

```text
research -> shadow -> paper_live_small -> paper_live_normal -> reduced -> disabled
```

Definitions:

- `research`: strategy exists in the registry but cannot open paper trades.
- `shadow`: strategy produces signals and simulated outcomes, but no paper position is opened.
- `paper_live_small`: strategy can open paper trades at reduced risk.
- `paper_live_normal`: strategy can open paper trades at normal configured risk.
- `reduced`: strategy remains enabled but risk is automatically lowered after recent weakness.
- `disabled`: strategy is blocked from new signals or paper entries.

All open positions continue to be monitored regardless of strategy status.

## Promotion Rules

Initial default rules:

| Transition | Criteria |
|---|---|
| `research` -> `shadow` | Strategy is enabled by configuration and has a signal generator wired into `bot_trade_signals` |
| `shadow` -> `paper_live_small` | At least 30 shadow outcomes, profit factor >= 1.10, positive average R, max drawdown within configured limit |
| `paper_live_small` -> `paper_live_normal` | At least 30 live paper trades after small-risk promotion, profit factor >= 1.20, no daily drawdown breach |
| Any live state -> `reduced` | Rolling profit factor < 1.00 or rolling drawdown exceeds limit |
| Any state -> `disabled` | Repeated invalid signals, data failures, or critical incident |

The feedback runner may reduce risk automatically. It may only increase risk within the configured lifecycle rules and never above the hard `1.5` multiplier cap.

## Data Model

### `bot_strategies`

Extend the existing table with lifecycle and risk controls:

- `lifecycle_status text not null default 'research'`
- `enabled boolean not null default false`
- `risk_multiplier numeric(8, 4) not null default 0.25`
- `max_risk_multiplier numeric(8, 4) not null default 1.5`
- `promotion_thresholds jsonb not null default '{}'::jsonb`
- `last_reviewed_at timestamptz`

Constraints:

- `lifecycle_status in ('research', 'shadow', 'paper_live_small', 'paper_live_normal', 'reduced', 'disabled')`
- `risk_multiplier >= 0`
- `risk_multiplier <= 1.5`
- `max_risk_multiplier <= 1.5`

### `bot_trade_signals`

New internal queue table for all strategy candidates:

- `id uuid primary key`
- `strategy_id uuid references bot_strategies(id)`
- `source text not null`
- `instrument_id uuid references instruments(id)`
- `side text not null`
- `signal_time timestamptz not null`
- `trigger_price numeric(14, 4) not null`
- `stop_loss_price numeric(14, 4) not null`
- `target_price numeric(14, 4) not null`
- `timeframe text not null default '1m'`
- `metadata jsonb not null default '{}'::jsonb`
- `status text not null default 'pending'`
- `rejection_reason text`
- `processed_at timestamptz`
- `created_at timestamptz not null default now()`

Statuses:

```text
pending, shadow_tracked, accepted, rejected, expired
```

The table is private to authenticated dashboard users for reads, and only service-role edge functions may write.

### `bot_signal_outcomes`

Tracks both shadow outcomes and live paper outcomes:

- `id uuid primary key`
- `signal_id uuid references bot_trade_signals(id)`
- `paper_trade_id uuid references bot_paper_trades(id)`
- `mode text not null`
- `entry_price numeric(14, 4) not null`
- `exit_price numeric(14, 4)`
- `exit_reason text`
- `gross_pnl numeric(14, 4)`
- `net_pnl numeric(14, 4)`
- `r_multiple numeric(14, 6)`
- `max_favorable_excursion numeric(14, 4)`
- `max_adverse_excursion numeric(14, 4)`
- `duration_minutes integer`
- `status text not null default 'open'`
- `opened_at timestamptz not null`
- `closed_at timestamptz`
- `created_at timestamptz not null default now()`

Modes:

```text
shadow, paper_live
```

### `bot_strategy_reviews`

Stores automatic feedback decisions:

- `id uuid primary key`
- `strategy_id uuid references bot_strategies(id)`
- `reviewed_at timestamptz not null default now()`
- `window_start timestamptz not null`
- `window_end timestamptz not null`
- `sample_count integer not null`
- `profit_factor numeric(14, 6)`
- `win_rate numeric(8, 4)`
- `average_r numeric(14, 6)`
- `max_drawdown numeric(14, 4)`
- `rejection_rate numeric(8, 4)`
- `previous_status text not null`
- `new_status text not null`
- `previous_risk_multiplier numeric(8, 4)`
- `new_risk_multiplier numeric(8, 4)`
- `decision text not null`
- `rationale text not null`
- `metrics jsonb not null default '{}'::jsonb`

## Edge Functions

### `bot-signal-executor`

Runs frequently during market hours.

Responsibilities:

1. Read pending rows from `bot_trade_signals`.
2. Load the strategy and lifecycle state.
3. Reject if strategy is disabled or malformed.
4. If strategy is `research`, reject or expire the signal.
5. If strategy is `shadow`, create a `bot_signal_outcomes` shadow row without opening a paper trade.
6. If strategy is paper-live, validate and open a row in `bot_paper_trades`.

Validation rules:

- Must respect `bot_settings.trading_enabled` for every live paper entry.
- Must still process shadow outcomes when trading is disabled.
- Must enforce paper-only execution.
- Must enforce max daily trades and max concurrent positions.
- Must reject duplicate strategy/instrument/day entries.
- Must sanity-check trigger price against latest 1-minute candle or last known price.
- Must apply the existing cost model:
  - 0.05% entry slippage
  - 0.05% target-exit slippage
  - 0.10% stop-exit slippage
  - Rs 40 brokerage per round trip
  - 0.05% statutory charge on exit
- Must cap applied strategy risk multiplier at `1.5`.

### `bot-feedback-run`

Runs after market close weekly, and can also be manually invoked.

Responsibilities:

1. Evaluate `bot_signal_outcomes` and closed `bot_paper_trades`.
2. Compute sample count, profit factor, win rate, average R, drawdown, rejection rate, and rolling recent performance.
3. Write a row to `bot_strategy_reviews`.
4. Update `bot_strategies.lifecycle_status` and `risk_multiplier` when criteria are met.
5. Send Telegram notifications for promotions, reductions, disables, and critical review failures.

Telegram secrets are expected to already live in Supabase function secrets or Vault-compatible environment values, using the existing shared Telegram helper.

### Existing Trading Functions

`orb-scanner` should stop inserting directly into `bot_paper_trades`. It should enqueue an ORB signal in `bot_trade_signals` instead.

`check-exits` and `eod-flatten` continue to close `bot_paper_trades`, then outcome rows are updated from the closed trade data.

Market Sniper-derived patterns should be added later by enqueueing `bot_trade_signals` with `source = 'market_sniper_pattern'`. They must not bypass the executor.

## Initial Strategy Scope

Start with `orb_breakout` because it is already the active bot strategy and has existing paper trade schema, tests, and cron flow.

After the ORB path is stable, add selected old pattern generators as signal sources through the same queue:

- `pdh_trap`
- `pdl_bounce`
- `or_trap`
- `or_breakout`
- `chanakya_daily`

Each strategy starts in `research` or `shadow`, never full paper-live by default.

## Error Handling

- Invalid signal rows are marked `rejected` with `rejection_reason`.
- Signals older than the configured TTL are marked `expired`.
- Executor failures write to `bot_incidents`.
- Feedback failures write to `bot_incidents`.
- Critical incidents trigger Telegram alerts.
- Kill switch blocks only new live paper entries. It does not block exit monitoring or shadow outcome tracking.

## Testing

Add focused tests for:

- Signal validation rejects malformed stop/target/side values.
- Executor respects `bot_settings.trading_enabled`.
- Executor creates shadow outcomes without paper trades.
- Executor creates paper trades only for paper-live strategies.
- Risk multiplier is capped at `1.5`.
- Duplicate symbol/day entries are rejected.
- Feedback run promotes only after minimum sample count.
- Feedback run demotes weak rolling performance.
- Telegram helper is called for promotion/demotion notifications through the existing shared notification path.

Do not add tests that require real Angel One, Telegram, or Supabase network calls.

## Deployment Notes

- Add migrations before function changes.
- Deploy `bot-signal-executor` and `bot-feedback-run`.
- Add pg_cron entries using existing `bot_project_url` / `bot_anon_jwt` secret fallback conventions.
- Keep existing `bot-premium-decay` and options dashboard behavior unchanged.
- Seed `orb_breakout` with lifecycle status `shadow` or `paper_live_small` depending on current operator preference during deployment.

