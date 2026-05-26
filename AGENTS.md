# Agent Conventions — Indian Market Scanner

This repo holds two systems sharing one Supabase project:

1. **Old "Market Sniper" code** (`dashboard/`, `quant-lab/`, `supabase/functions/scan-*`) — deprecated. Do not modify unless explicitly asked. Will be archived once v1 of the bot is stable.
2. **New "Auto Paper-Trading Bot"** (`bot/` + `supabase/functions/bot-*` + `supabase/migrations/*_bot_*`) — active development.

## Authoritative spec

Every issue references this spec — read it before coding:

`docs/superpowers/specs/2026-05-21-market-alert-system-design.md`

Architecture decisions live in `docs/adr/`.

## v1 hard rules (do not deviate)

- All bot tables are prefixed `bot_*`
- Bot edge functions are prefixed `bot-*`
- v1 is **pure Supabase** — no Node workers, no Railway, no DigitalOcean. Hybrid architecture is deferred to v1.2 (see `docs/adr/0003-...`).
- Paper trades use **1-minute candle OHLC** for stop/target detection — never tick data
- Every order applies the cost model from the spec: 0.05% entry slip, 0.05% target-exit slip, 0.10% stop-exit slip, ₹40 brokerage, 0.05% statutory on exit
- Adaptive risk multiplier is capped at **1.5×**. Hard-coded. Never remove this cap.
- The `bot_settings.trading_enabled` kill switch must be respected by every entry-placement codepath. Open positions are always monitored, regardless of the switch.

## v1 tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 + React 19 + TypeScript + TailwindCSS — lives in `bot/` |
| Backend | Supabase (PostgreSQL + Edge Functions + pg_cron + Realtime + Vault) |
| Market data | Angel One SmartAPI (REST endpoints only in v1) |
| Notifications | Telegram Bot API |
| Backtest | Python + vectorbt in `quant-lab/` (smoke test only) |

## Repo conventions

- Use `pnpm` inside `bot/` for installs (matches the workspace config in `dashboard/`)
- Edge Function shared code goes in `supabase/functions/_shared/`
- Migration timestamps follow `YYYYMMDDHHMMSS_description.sql`
- Commit messages start with `RALPH:` when produced by an agent (see implement-prompt)
- Never modify the active `master` branch directly — work on a feature branch and merge through the Sandcastle pipeline

## Forbidden patterns

- Per-trade conviction prediction or score (SEBI compliance line)
- Bypassing the kill switch
- Removing the 1.5× risk-multiplier cap
- Real-money order execution from any v1 code path
- Treating paper trades as real (no zero-cost simulation, ever)
