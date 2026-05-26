# Auto Paper-Trading Bot — Design Document
**Status:** Awaiting user review before transition to implementation plan
**Date:** 2026-05-21
**Project status:** New project. Old "Market Sniper" codebase is deprecated and will be archived.

---

## Purpose

A fully automatic intraday paper-trading bot for Indian markets (NSE), built in stages toward a long-term passive earnings machine. Personal-use first, designed for SaaS-readiness, self-improving via parameter tuning.

---

## Why We're Starting Fresh

The old "Market Sniper" codebase had three terminal problems we are not repeating:

1. **Regulatory mismatch** — gave buy/sell recommendations to users, blurring the SEBI investment-advisor line
2. **Technical mismatch** — Shadow Trades had no slippage, fees, or fill realism. Self-improvement on those numbers would train on lies.
3. **Scope creep** — scanner + paper trading + backtesting + alerts in one codebase, none done well

---

## Core Decisions

| Decision | Locked Value |
|---|---|
| Execution model | Auto paper-trader. No manual mode. |
| Notification model | Telegram = transparency feed (system narrates what it did). Not action prompt. |
| v1 strategy | Opening Range Breakout (ORB) only |
| Self-improvement | Level 1 parameter tuning. Data model ready for Level 2 (strategy weighting). |
| Real-money cutoff | No earlier than month 3. Tiny size (₹10–20k) when started. |
| Project structure | New `bot/` folder in this repo. Same Supabase project. Old code stays for reference until v1 stable, then archived. |
| New tables prefix | `bot_*` (e.g. `bot_paper_trades`, `bot_strategies`) |

---

## Domain Language (replaces old `CONTEXT.md` terms)

| Term | Definition |
|---|---|
| **Operator** | The human (Soham) who owns the bot. Currently sole user. |
| **Strategy** | A named ruleset for entering/exiting trades. v1 has one: `orb_breakout`. |
| **Strategy Parameters** | The tunable knobs of a strategy (e.g. `range_minutes`, `volume_multiplier`). |
| **Paper Trade** | A bot-placed virtual position with full execution realism (slippage, fees, fills). The bot is the actor — no human input. |
| **Tuning Run** | Weekly Sunday process that scores parameter sets and nudges production parameters. |
| **Kill Switch** | A Supabase flag (`bot_settings.trading_enabled`). When false, no new entries placed; existing positions still monitored. |

**Terms no longer used:** Shadow Trade, Liquidity Trap Alert, Conviction Score, Score Factor, Market Sniper User.

---

## Architecture

### v1 (paper trading, months 1–3): Pure Supabase

```
                 Angel One SmartAPI (REST only)
                          |
                          v
              +------------------------+
              | Supabase Edge Function |
              | (cron, 1-min)          |
              | - Candle ingest        |
              | - ORB scanner          |
              | - Paper exec & exits   |
              | - Heartbeat & EOD      |
              +------------------------+
                          |
                          v
              +----------------------+
              |     Supabase DB      |
              +----------------------+
                  /        |        \
                 v         v         v
            Telegram   Dashboard   Tuning Run
```

Paper trades use 1-minute candle OHLC to detect stop/target hits — industry-standard for simulated execution. No real-time tick feed needed because no real orders are placed.

### v1.2+ (real money): Add a Mumbai/Bangalore DigitalOcean droplet

Once paper trading proves edge, add a small Node WebSocket worker on a **DigitalOcean Bangalore droplet** (covered by GitHub Student Pack credit — $200 = ~40 months of $5/mo droplet). The droplet maintains a persistent WebSocket to Angel One for sub-second stop/target execution on real orders. Supabase remains the database; the droplet is purely the execution arm. See `docs/adr/0003-hybrid-serverless-websocket-architecture.md` for full rationale.

---

## v1 Strategy: Opening Range Breakout (ORB)

**Rules:**
1. Opening range = high & low of first 15 minutes after market open (9:15–9:30 IST)
2. After 9:30:
   - Price breaks **above** range high with volume ≥ multiplier × avg → **long**
   - Price breaks **below** range low with volume ≥ multiplier × avg → **short**
3. Stop loss = opposite side of opening range (v1) → ATR-based (v1.1)
4. Target = entry ± `target_multiplier` × range width
5. Force exit at 3:15 PM IST if no stop/target hit
6. Universe = Nifty 50

**Default parameters (v1 start, tuner can nudge in v1.1):**
- `range_minutes` = 15
- `volume_multiplier` = 1.5
- `target_multiplier` = 1.5
- `atr_stop_multiplier` = 1.0 (v1.1+)
- `strategy_risk_multiplier` = 1.0, capped at 1.5 (v1.1+)

---

## Risk Model

| Knob | v1 Value | Notes |
|---|---|---|
| Starting paper capital | ₹1,00,000 | Realistic position sizing on Nifty 50 |
| Risk per trade | 1% = ₹1,000 | Standard professional risk |
| Max concurrent positions | 2 | Avoids correlated risk |
| Daily drawdown circuit-breaker | -3% (₹3,000) | Bot pauses for the day, resumes next morning |

**Position sizing formula:** `shares = floor(risk_per_trade × strategy_risk_multiplier / (entry_price − stop_loss_price))`

**Hard cap:** `strategy_risk_multiplier` is bounded at **1.5×** — the bot can never risk more than ₹1,500 per trade regardless of how confident the tuner gets.

---

## Paper Trade Realism

| Cost | Simulation |
|---|---|
| Brokerage | ₹20 per leg = ₹40 per round-trip |
| Statutory charges | 0.05% deducted on exit (STT + Exchange + SEBI + Stamp + GST combined) |
| Entry slippage | 0.05% against you (long fills higher, short fills lower) |
| Exit slippage (target) | 0.05% against you |
| Exit slippage (stop) | 0.10% against you (2× — stops fire in fast markets) |

**Slippage is always against you.** No favorable slippage in the simulator.

---

## Self-Improvement Loop (Level 1)

| Aspect | Locked Value |
|---|---|
| Cadence | Weekly, Sundays |
| Score function | **Profit Factor** = gross wins ÷ gross losses |
| Minimum trades per parameter set | **30** (tuner cannot promote any set below this) |
| Update mechanism | **Gradient nudge**: move current parameters halfway toward best-scoring set |
| Tunable knobs (v1.1) | `volume_multiplier`, `target_multiplier`, `atr_stop_multiplier`, `strategy_risk_multiplier` |
| Forbidden | Per-trade conviction prediction. Tuner cannot decide "this specific setup is high quality, bet more." |

Every tune is logged in `bot_parameter_history` with rationale: "Moved volume_multiplier 1.5 → 1.65 because parameter set with 1.8 had Profit Factor 1.7 over 42 trades."

---

## Failure Handling & Guardrails

| Failure | Response |
|---|---|
| WebSocket disconnect | Exponential backoff reconnect (1s→30s max). 60s no-reconnect → emergency-flatten all open positions via REST. |
| Worker crash | Railway auto-restart. On restart, reads open positions from Supabase, resumes monitoring. |
| Angel One API error/rate-limit | Retry with backoff. 3 fails → write to `bot_incidents`. Edge Function alerts via Telegram. |
| Instrument halt/circuit-lock | Position marked `frozen`. No stop attempts. Force-close at next market open. |
| Bot logic bug / wrong trade | **Kill switch** — Supabase flag toggled from dashboard or Telegram in 2 seconds. |

**System-wide guardrails:**
- **Heartbeat**: Worker writes `last_heartbeat_at` every 30s. Edge Function alerts if stale > 5 min during market hours.
- **Daily kill switch**: Auto-flatten all open paper trades at 3:30 PM IST. No overnight positions.
- **Sanity bounds**: Reject any order whose entry price is ±5% off the last REST price.

---

## Dashboard Scope

| Phase | Items shipped |
|---|---|
| **v1 (weeks 1–4)** | (1) System status banner, (2) Kill switch, (3) Open positions table, (4) Today's trades list, (5) Incident log |
| **v1.1 (weeks 5–8)** | + Strategy performance card, parameter change log, equity curve |
| **v1.2+ (weeks 9+)** | + Trade history search, TradingView embed, Supabase Auth (dad/brother accounts) |

No login wall in v1 — just one operator, no accounts needed yet.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Dashboard | Next.js + TypeScript + TailwindCSS (in `bot/`) |
| Realtime | Supabase Realtime (subscribe to `bot_paper_trades`, `bot_settings`) |
| Database & Edge Functions & Cron | Supabase (same project, new tables prefixed `bot_`) |
| WebSocket worker | Node.js + TypeScript, deployed on Railway free tier |
| Market data | Angel One SmartAPI (REST for candles, WebSocket for ticks) |
| Notifications | Telegram Bot API |
| Backtest (smoke test only) | Reuse existing `quant-lab/` (Python + vectorbt) |

---

## Timeline

| Phase | Weeks | Ships |
|---|---|---|
| v1 | 1–4 | ORB scanner + paper executor + Telegram feed + v1 dashboard. Live paper trades. |
| v1.1 | 5–8 | Level 1 tuner. Strategy performance card. Adaptive stops + risk. Still paper only. |
| v1.2 | 9–12 | Smoke test passes → first real money (₹10–20k), ORB only, single instrument. |
| v2.x | 13–32 | Add VWAP Reclaim → HH/LL momentum → Gap and Go. Each strategy 30-day paper-first. |
| v3.x | 32+ | Level 2 strategy weighting. Scale capital. Optional Level 3 (LLM strategy generation). |

---

## Database Schema (sketch — to be detailed in implementation plan)

```sql
-- Reuse existing instruments table (with angel_one_token column)

bot_settings (
  id, trading_enabled boolean, kill_switch_reason text,
  paper_capital numeric, daily_drawdown_cap numeric,
  last_heartbeat_at timestamptz, updated_at, updated_by
)

bot_strategies (
  id, name, version, status,        -- e.g. 'orb_breakout', 'v1', 'active'
  created_at, updated_at
)

bot_strategy_parameters (
  id, strategy_id, name, value numeric, min_value, max_value,
  is_tunable boolean, updated_at
)

bot_parameter_history (
  id, strategy_id, parameter_name, old_value, new_value,
  rationale text, tuner_run_id, changed_at
)

bot_candles (
  id, instrument_id, timeframe, open, high, low, close, volume,
  candle_open_at, source, created_at
)

bot_paper_trades (
  id, strategy_id, instrument_id,
  side ('long'|'short'),
  entry_price, entry_time, entry_slippage_pct,
  stop_loss_price, target_price,
  exit_price, exit_time, exit_reason ('target'|'stop'|'eod'|'manual'|'frozen'),
  shares, gross_pnl, brokerage, statutory_charges, net_pnl,
  risk_amount, status ('open'|'closed'|'frozen'),
  created_at, updated_at
)

bot_tuning_runs (
  id, strategy_id, run_at, score_function, min_trades_threshold,
  best_parameter_set jsonb, score numeric,
  parameters_updated jsonb, rationale text
)

bot_incidents (
  id, severity ('info'|'warn'|'critical'),
  source, message, context jsonb,
  resolved_at, created_at
)
```

---

## Compliance Notes

- Personal use in v1–v2. No SEBI registration required.
- When moving toward SaaS: research SEBI Research Analyst registration + broker algo registration. Take legal advice before adding paying users.
- All paper trades labelled "simulated" in UI and Telegram.
- No per-trade conviction prediction (intentionally — that's the SEBI line).
- Future SaaS: each user connects their own Angel One credentials. Bot never holds pooled funds.

---

## Open Items (deferred to implementation plan)

- Telegram message format (templates for entry/exit/incident)
- File structure inside `bot/` (Next.js layout, worker code layout)
- Specific Angel One SmartAPI client (TS library or hand-rolled)
- Railway deployment config (env vars, healthcheck endpoint)
- Smoke-test script in `quant-lab/` (parameters, output format)
- Telegram bot setup (BotFather, chat ID storage in Supabase Vault)
