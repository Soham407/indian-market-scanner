# Paper Trading Bot v1 Deployment Guide

## Overview

The automated paper trading bot implements a complete opening-range breakout (ORB) strategy with full risk management, circuit breaker protection, and Telegram notifications.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Automated Trading Bot                   │
├─────────────────────────────────────────────────────┤
│ Phase 1: 9:15-9:30 IST                              │
│  └─ orb-scanner: Build opening range + detect BO   │
├─────────────────────────────────────────────────────┤
│ Phase 2: 9:30-15:30 IST (Every 1 min)              │
│  └─ check-exits: Monitor stops/targets              │
├─────────────────────────────────────────────────────┤
│ Phase 3: 15:15 PM IST                              │
│  └─ eod-flatten: Close all positions + circuit B   │
├─────────────────────────────────────────────────────┤
│ Monitoring: 9:15-15:30 IST (Every 15 min)          │
│  └─ bot-health-check: Stale data + heartbeat       │
├─────────────────────────────────────────────────────┤
│ Notifications                                       │
│  └─ Telegram: Entry, exit, circuit breaker, errors │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

### 1. Supabase Setup

```bash
# Create tables and migrations
supabase migration list
supabase migration push

# Enable PgCron for scheduled functions
# (Required for cron jobs)
```

### 2. Environment Variables

```bash
# Copy template
cp .env.example .env.local

# Fill in your credentials
# - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
# - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
# - ANGEL_ONE_API_KEY / ANGEL_ONE_CLIENT_CODE
```

### 3. Telegram Bot Setup

```bash
# 1. Create bot with BotFather (@BotFather)
# 2. Get TELEGRAM_BOT_TOKEN from response
# 3. Message your bot and get chat ID:
#    curl https://api.telegram.org/bot<TOKEN>/getUpdates | grep chat_id
# 4. Add to .env as TELEGRAM_CHAT_ID
```

### 4. Angel One API Credentials

- Login to Angel One dashboard
- API Management → Generate API credentials
- Use CLIENT_CODE and API_KEY

## Deployment Steps

### 1. Deploy Edge Functions

```bash
# Deploy all bot functions to Supabase
supabase functions deploy orb-scanner
supabase functions deploy check-exits
supabase functions deploy eod-flatten
supabase functions deploy bot-health-check

# Deploy shared utilities
# (Automatically included in functions)
```

### 2. Apply Database Migrations

```bash
# Bot schema and config
supabase migration up 20260520120000_bot_config_table

# Cron job schedule
supabase migration up 20260521120000_bot_cron_schedule
```

### 3. Configure Secrets in Supabase

```sql
-- In Supabase SQL Editor:
INSERT INTO vault.secrets (name, secret)
VALUES 
  ('telegram_bot_token', 'your-token'),
  ('telegram_chat_id', 'your-chat-id'),
  ('angel_one_api_key', 'your-api-key'),
  ('angel_one_client_code', 'your-client-code'),
  ('market_sniper_project_url', 'https://your-project.supabase.co'),
  ('market_sniper_anon_jwt', 'your-anon-jwt');
```

### 4. Enable Cron Extension

```bash
# Supabase: Database → Extensions → pg_cron → Enable
# OR run SQL:
CREATE EXTENSION IF NOT EXISTS pg_cron;
```

### 5. Initialize Bot Config

```sql
-- Supabase SQL Editor:
INSERT INTO bot_config (id, trading_enabled)
VALUES (1, true)
ON CONFLICT (id) DO UPDATE
SET trading_enabled = true;
```

## Testing

### 1. Test Individual Functions

```bash
# Test ORB scanner
curl -X POST https://your-project.supabase.co/functions/v1/orb-scanner \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json"

# Test exit handler
curl -X POST https://your-project.supabase.co/functions/v1/check-exits \
  -H "Authorization: Bearer $ANON_KEY"

# Test health check
curl -X POST https://your-project.supabase.co/functions/v1/bot-health-check \
  -H "Authorization: Bearer $ANON_KEY"
```

### 2. Run Unit Tests

```bash
# Test individual modules
deno test supabase/functions/orb-scanner/orb-scanner.test.ts
deno test supabase/functions/check-exits/check-exits.test.ts
deno test supabase/functions/eod-flatten/eod-flatten.test.ts
deno test supabase/functions/bot-health-check/health-check.test.ts

# Test shared utilities
deno test supabase/functions/_shared/indicators.test.ts
deno test supabase/functions/_shared/telegram.test.ts

# Run smoke test
python3 quant-lab/backtest_orb_strategy.py
```

### 3. Monitor Logs

```bash
# View function logs in Supabase Dashboard:
# - Functions → <function-name> → Logs
# - Filter by date/status

# Check Telegram channel for notifications
```

## Production Monitoring

### 1. Daily Checks

- [ ] Health check heartbeats arriving in Telegram (every 15 min during market hours)
- [ ] No stale data alerts
- [ ] Circuit breaker not triggered (unless intended)
- [ ] Entry/exit notifications received as trades execute

### 2. Weekly Reviews

- [ ] P&L tracking (`SELECT SUM(net_pnl) FROM bot_paper_trades WHERE status='closed'`)
- [ ] Win rate analysis (`SELECT COUNT(CASE WHEN net_pnl > 0 THEN 1 END) / COUNT(*) FROM bot_paper_trades`)
- [ ] Position sizing consistency
- [ ] Slippage vs actual execution

### 3. Emergency Kill Switch

```sql
-- Disable trading immediately (circuit breaker bypass)
UPDATE bot_config 
SET trading_enabled = false, circuit_breaker_triggered_at = NOW()
WHERE id = 1;

-- Re-enable when ready
UPDATE bot_config 
SET trading_enabled = true, circuit_breaker_triggered_at = NULL
WHERE id = 1;
```

## Performance Tuning

### Cron Job Schedule

Current schedule (every 5 min for ORB, every 1 min for exits):

```
orb-scanner:     */5 3,4,5,6,7,8,9 * * 1-5  (9:15-15:30 IST)
check-exits:     * 4,5,6,7,8,9 * * 1-5      (9:30-15:30 IST)
eod-flatten:     45 9 * * 1-5                (3:15 PM IST)
bot-health-check: */15 3,4,5,6,7,8,9 * * 1-5 (every 15 min)
```

### Tuning Parameters

- **VOLUME_MULTIPLIER**: 1.5 (requires 1.5× average volume for breakout)
- **RISK_PER_TRADE**: ₹1,000 (adjust based on account size)
- **CIRCUIT_BREAKER**: -₹3,000 daily loss (adjust for risk tolerance)
- **HEARTBEAT_INTERVAL**: 15 minutes (Telegram notification frequency)

## Rollback Procedure

```bash
# 1. Stop trading via circuit breaker
UPDATE bot_config SET trading_enabled = false WHERE id = 1;

# 2. Disable cron jobs
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'bot-%';

# 3. Close any open trades manually
UPDATE bot_paper_trades SET status = 'closed', exit_reason = 'manual' 
WHERE status = 'open';

# 4. Review logs and incidents
# (Supabase Functions → Logs)
```

## Security Best Practices

1. **Never commit `.env`** — Only commit `.env.example`
2. **Use Supabase Vault** for all secrets (not environment variables)
3. **Rotate Telegram token** if compromised
4. **Audit trade logs** for unauthorized entries
5. **Monitor health checks** for interruptions

## Support

- **Logs**: Supabase Dashboard → Functions
- **Database**: Supabase Dashboard → SQL Editor
- **Monitoring**: Telegram notifications + health checks
- **Backtest**: `python3 quant-lab/backtest_orb_strategy.py`

---

**Last Updated**: May 26, 2026  
**Status**: Production Ready (v1)
