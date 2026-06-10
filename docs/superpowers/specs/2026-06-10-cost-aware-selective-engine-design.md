# Cost-Aware Selective Trading Engine

**Date:** 2026-06-10
**Status:** Approved
**Scope:** Equity paper-trading bot only. The options dashboard (`bot/` app, premium-decay/OI tables) is untouched.

## Problem

Live results June 1–5 2026: 88 closed trades, gross ₹-2,058, net ₹-7,858, charges ₹5,801.
The headline strategy (orb_breakout) is nearly breakeven gross (₹-612 over 63 trades) —
costs are the loss. Exit breakdown: only 4/88 trades hit target (avg +₹76), 12 hit stop
(avg -₹552), 72 drifted to EOD flatten (each paying ~₹21 charges for nothing).

Diagnosis: too many low-conviction trades, inverted stop/target asymmetry, and no exit
for momentum-dead positions. Fixed ₹40/round-trip brokerage + STT makes small churny
trades structurally unprofitable at ₹1L capital.

## Goal

Net-positive expectancy on paper at simulated ₹1L capital (risk ₹1,000/trade), proven
through the existing shadow-tracking/promotion engine before any real money. Sizing
scales via one config value.

## Design

### 1. Signal quality score + selectivity
Where: `supabase/functions/scan-alerts` (strategy signal generation) and `orb-scanner`.

Each candidate signal gets a 0–100 score:
- **Volume surge** (0–40): current vs recent average minute-volume for the symbol.
- **OR-range sanity** (0–20): opening range between 0.3% and 5% of price scores high;
  edges score low.
- **Relative strength vs NIFTY** (0–25): symbol's move since open vs NIFTY's move,
  directionally aligned with the signal side.
- **Time-of-day** (0–15): full marks before 11:00 IST, decaying to 0 by 13:00 IST.

Signals scoring ≥ threshold (start: 60) insert as `pending`; below threshold insert as
`shadow_tracked` with the score in `metadata` so the promotion engine still measures
them. Score and components always stored in `bot_trade_signals.metadata`.

Hard caps (in `bot_settings`): `max_daily_trades = 5`, `max_concurrent_positions = 3`.

### 2. Trade economics gate
Where: `supabase/functions/bot-signal-executor`.

Before accepting a pending signal:
- `p` = strategy's live win rate from closed `bot_signal_outcomes` (min 20 samples,
  else fallback 0.40).
- `EV = p × (target_dist × shares) − (1−p) × (stop_dist × shares) − round_trip_charges`
  where `round_trip_charges = ₹40 + 0.05% of trade value`.
- Reject (`rejection_reason = 'economics'`) if `EV ≤ 0` or charges > 10% of the
  expected win `(target_dist × shares)`.

Rejected-for-economics signals become `shadow_tracked`, not dropped.

### 3. Exit overhaul
Where: `supabase/functions/check-exits` (runs every minute); stop/target set at signal time.

- **ATR stops:** stop distance = 1.0 × ATR(14, 1-min aggregated to 5-min) at signal
  time, clamped to [0.4%, 1.5%] of price. Target = 1.5 × stop distance (≥1.5R).
- **Breakeven move:** when price reaches entry + 1R, stop moves to entry (one-way).
  Requires `bot_paper_trades.stop_moved_to_breakeven boolean` (migration).
- **Time-stop:** if trade age > 60 min and unrealized P&L < +0.5R, exit at market with
  `exit_reason = 'time_stop'` (extend the exit_reason check constraint).

### 4. NIFTY regime filter
Where: signal generation (scan-alerts / orb-scanner).

Using NIFTY spot (already collected into `bot_settings` by bot-premium-decay) and
NIFTY's own opening range (9:15–9:30, computed and cached daily): allow longs only when
NIFTY > OR-high, shorts only when NIFTY < OR-low, no new entries while inside its OR.
If NIFTY data is stale (>10 min), the filter abstains (does not block).

### 5. Watchdog
Where: `supabase/functions/bot-health-check` (already on a 15-min cron).

After 11:00 IST on a trading day with `trading_enabled = true`: if zero accepted trades
AND zero pending signals AND last `bot_candles` row older than 10 min → Telegram error
alert naming the dead component (candles stale vs no signals vs executor idle).
Fires at most once per day (tracked in `bot_settings.watchdog_alerted_date`).

### 6. Promotion gates to real money
Config only — written into `bot_strategies.promotion_thresholds`:
`{"real_money_min_trades": 60, "real_money_min_profit_factor": 1.3,
"real_money_max_drawdown_pct": 5, "real_money_min_weeks": 4}`.
No code path wires real money; gates are the documented bar for ever doing so.

## Measurement

Shadow-tracked signals are the control group. The weekly `bot-feedback-run` compares
accepted vs shadow outcomes. Success after ~2–4 weeks of market days: net profit factor
of accepted trades > 1.0 and > shadow cohort's.

## Out of scope

Overnight holds, options strategies, LLM signal scoring (revisit after 60+ clean
trades), any real-money execution path.
