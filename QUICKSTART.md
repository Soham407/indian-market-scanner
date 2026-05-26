# Paper Trading Bot - Quick Start

Get the automated ORB paper-trading bot running in 10 minutes.

## Prerequisites

- [ ] Supabase account with database
- [ ] Telegram bot (from @BotFather)
- [ ] Angel One API credentials
- [ ] Node.js 18+ and Deno 1.40+

## 1. Clone & Setup (2 min)

```bash
git clone https://github.com/Soham407/indian-market-scanner.git
cd indian-market-scanner

# Copy environment template
cp .env.example .env.local

# Edit with your credentials
nano .env.local
```

## 2. Environment Variables (3 min)

Get your credentials and fill in `.env.local`:

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Telegram (get from @BotFather)
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklmnoPQRstuvWXyz
TELEGRAM_CHAT_ID=987654321

# Angel One (from API settings)
ANGEL_ONE_API_KEY=your-api-key
ANGEL_ONE_CLIENT_CODE=your-client-code
```

## 3. Deploy Functions (2 min)

```bash
# Login to Supabase
supabase login

# Deploy all bot functions
supabase functions deploy orb-scanner
supabase functions deploy check-exits
supabase functions deploy eod-flatten
supabase functions deploy bot-health-check
```

## 4. Setup Database (1 min)

```bash
# Apply migrations
supabase migration up 20260520120000_bot_config_table
supabase migration up 20260521120000_bot_cron_schedule

# Initialize bot config
# (Run in Supabase SQL editor)
INSERT INTO bot_config (id, trading_enabled)
VALUES (1, true)
ON CONFLICT (id) DO UPDATE SET trading_enabled = true;
```

## 5. Test Everything (2 min)

```bash
# Run unit tests
deno test supabase/functions/orb-scanner/orb-scanner.test.ts
deno test supabase/functions/check-exits/check-exits.test.ts
deno test supabase/functions/eod-flatten/eod-flatten.test.ts
deno test supabase/functions/bot-health-check/health-check.test.ts

# Run backtest
python3 quant-lab/backtest_orb_strategy.py

# Expected: 73 tests passing + backtest metrics
```

## Done! 🎉

Your bot is now live. Next trading day:

- 9:15 AM IST: Opens with opening range building
- 9:30 AM - 3:15 PM IST: Monitors for breakouts and exits
- Check Telegram for real-time notifications
- Dashboard shows trading status and circuit breaker

## Monitoring

### Telegram Notifications
- You'll get entries, exits, circuit breaker alerts, and heartbeats
- Heartbeat every 15 min shows open trades + daily P&L

### Dashboard
- Visit `http://localhost:3000/dashboard`
- See trading status toggle (kill switch)
- Monitor circuit breaker state

### Logs
- **Supabase**: Functions → Logs
- **Database**: Check `bot_paper_trades` table for executed trades
- **Stats**: Query daily P&L with:
  ```sql
  SELECT SUM(net_pnl) as daily_pnl FROM bot_paper_trades
  WHERE status = 'closed' AND DATE(exit_time) = CURRENT_DATE;
  ```

## Stop Trading

### Emergency Kill Switch
```sql
-- Disable immediately
UPDATE bot_config SET trading_enabled = false WHERE id = 1;

-- Close all open positions
UPDATE bot_paper_trades SET status = 'closed', exit_reason = 'manual'
WHERE status = 'open';
```

### Or use Dashboard
- Toggle "Trading Status" to OFF

## Next Steps

- 📖 Read `BOT.md` for detailed feature descriptions
- 🚀 Read `DEPLOYMENT.md` for production setup
- 🧪 Run `python3 quant-lab/backtest_orb_strategy.py` for backtesting
- 📊 Monitor P&L in database and Telegram

## Troubleshooting

### No Telegram notifications?
1. Check bot token is correct: `curl https://api.telegram.org/bot<TOKEN>/getMe`
2. Send message to bot and verify chat ID
3. Check function logs for errors

### No trades placed?
1. Check `bot_candles` table has recent 1-min data
2. Verify market hours: 9:15-15:30 IST (weekdays only)
3. Check trading_enabled = true in bot_config

### Functions not running?
1. Verify migrations applied: `supabase migration list`
2. Check cron jobs: Supabase → Database → Scheduled Jobs
3. View logs: Supabase → Functions → Logs

---

**Need help?** See `DEPLOYMENT.md` for detailed setup or `BOT.md` for feature overview.

Happy trading! 🚀
