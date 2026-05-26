# Hybrid Serverless + WebSocket Worker Architecture

**Status:** Accepted (supersedes ADR-0001 for the auto paper-trading bot scope)
**Date:** 2026-05-21

The auto paper-trading bot runs on two runtimes: Supabase Edge Functions on cron for ORB entry detection (1-minute granularity is acceptable), and a single always-on Node WebSocket worker on Railway free tier for real-time stop-loss and target monitoring of open positions. Pure serverless polling cannot fire stops at sub-minute precision, which systematically underestimates losses in fast moves and would defeat the daily drawdown circuit-breaker. A pure always-on architecture has a single point of failure that loses the entire trading day if the worker crashes. The hybrid keeps the slow path serverless and stateless, isolates the latency-sensitive path to a small worker with crash-recovery, and uses Supabase as the single source of truth so both runtimes converge on the same trade state. ADR-0001 still applies to the old "Market Sniper" dashboard scope but is superseded for the new bot.
