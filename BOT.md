# Automated Paper Trading Bot v1

Complete automated trading bot implementing Opening Range Breakout (ORB) strategy with risk management, circuit breaker protection, and Telegram notifications.

## Features

### 1. Opening Range Breakout (ORB) Scanner
- **Timing**: 9:15-9:30 AM IST (OR building window)
- **Window**: 9:30-3:30 PM IST (trading window)
- **Logic**:
  - Tracks opening range highs/lows from first 15 min of trading
  - Detects breakouts when price closes beyond OR bounds with volume
  - Volume requirement: 1.5× multiplier on 10,000 base
  - **File**: `supabase/functions/orb-scanner/index.ts`

### 2. Exit Handler
- **Timing**: Runs every 1 minute during market hours
- **Monitors**: All open trades for:
  - Stop loss hits (exits with ±0.10% slippage)
  - Target hits (exits with ±0.05% slippage)
- **P&L Calculation**:
  - Gross P&L from price differential
  - Statutory charges (0.05% of exit value)
  - Brokerage (₹20 per leg = ₹40 round-trip)
  - Net P&L = Gross - Charges
- **File**: `supabase/functions/check-exits/index.ts`

### 3. End-of-Day (EOD) Flatten
- **Timing**: 3:15 PM IST (market close)
- **Action**: Closes all open positions at latest candle close
- **Circuit Breaker**: Halts trading if daily loss ≥ ₹3,000 (-3%); writes the halt to `bot_settings` (the gate the scanners read) and auto-resumes the next trading day via orb-scanner. A manual kill switch from the dashboard stays off until re-enabled.
- **File**: `supabase/functions/eod-flatten/index.ts`

### 4. Kill Switch UI
- **Component**: React dashboard toggle for `trading_enabled`
- **Real-time**: Supabase channel sync
- **Features**:
  - Trading status indicator (green/red)
  - Circuit breaker alert with reset button
  - Manual trading pause/resume
- **File**: `apps/web/app/dashboard/bot-controls.tsx`

### 5. Telegram Notifications
- **Events**:
  - Entry: Symbol, side, entry price, target, stop, risk amount
  - Exit: Exit reason, P&L, net profit/loss
  - Circuit Breaker: Daily loss threshold breach
  - Heartbeat: Trading status + daily P&L (15-min intervals)
  - Error: Data staleness, execution failures
- **File**: `supabase/functions/_shared/telegram.ts`

### 6. Health Check & Heartbeat
- **Stale Data Detection**: Alerts if >5 instruments missing 1-min candles for >5 minutes
- **Heartbeat**: Every 15 minutes with:
  - Trading status (enabled/disabled/circuit breaker)
  - Open trades count
  - Daily P&L
- **Status**: Healthy/degraded based on data freshness
- **File**: `supabase/functions/bot-health-check/index.ts`

### 7. Smoke Test (Backtest)
- **Period**: 3 months (Feb-Apr 2026)
- **Instruments**: 50 NIFTY-50 stocks
- **Logic**: 
  - Mock candle generation with realistic ranges
  - Full P&L pipeline (entry slippage → fees → exit slippage)
  - Daily aggregation and metrics
- **Metrics**: Trade count, win rate, profit factor, max drawdown
- **File**: `quant-lab/backtest_orb_strategy.py`

## Configuration

### Risk Management
```typescript
const RISK_PER_TRADE = 1000;           // ₹1,000 per trade
const DAILY_LOSS_CIRCUIT_BREAKER = -3000; // -₹3,000 = -3%
const VOLUME_MULTIPLIER = 1.5;         // 1.5× volume filter
```

### Timing (IST)
```typescript
const OR_WINDOW_START = 9 * 60 + 15;  // 9:15 AM IST
const OR_WINDOW_END = 9 * 60 + 30;    // 9:30 AM IST
const EOD_TIME = 15 * 60 + 15;        // 3:15 PM IST
const BREAKOUT_WINDOW_END = 15 * 60 + 30; // 3:30 PM IST
```

### Slippage & Fees
```typescript
const ENTRY_SLIPPAGE_PCT = 0.0005;    // 0.05%
const STOP_SLIPPAGE_PCT = 0.0010;     // 0.10%
const TARGET_SLIPPAGE_PCT = 0.0005;   // 0.05%
const STATUTORY_FEE_PCT = 0.0005;     // 0.05% of exit value
const BROKERAGE_PER_LEG = 20;          // ₹20 per leg
```

## Data Model

### bot_paper_trades
```sql
id                    UUID PRIMARY KEY
strategy_id          TEXT              -- 'orb_breakout'
instrument_id        UUID FOREIGN KEY  -- From instruments table
side                 TEXT              -- 'long' | 'short'
entry_price          NUMERIC           -- With slippage applied
entry_time           TIMESTAMP
entry_slippage_pct   NUMERIC
stop_loss_price      NUMERIC
target_price         NUMERIC
shares               INTEGER
status               TEXT              -- 'open' | 'closed'
exit_price           NUMERIC           -- With slippage applied
exit_time            TIMESTAMP
exit_reason          TEXT              -- 'target' | 'stop' | 'eod_flatten'
risk_amount          NUMERIC           -- Original ₹1000
gross_pnl            NUMERIC
statutory_charges    NUMERIC
brokerage            NUMERIC
net_pnl              NUMERIC
created_at           TIMESTAMP
```

### bot_config
```sql
id                              INTEGER PRIMARY KEY (1)
trading_enabled                 BOOLEAN DEFAULT true
circuit_breaker_triggered_at    TIMESTAMP
last_trading_date              DATE
created_at                      TIMESTAMP
updated_at                      TIMESTAMP
```

## Daily Workflow

```
9:15 AM IST
├─ Market opens
├─ orb-scanner starts: builds opening range (9:15-9:30)
│
9:30 AM IST
├─ OR finalized
├─ Breakout detection enabled
├─ check-exits enabled (monitors every 1 min)
│
9:30 AM - 3:15 PM
├─ Trades entered on breakouts
├─ Positions monitored for stops/targets
├─ Health checks run every 15 min
├─ Telegram notifications for events
│
3:15 PM IST
├─ eod-flatten closes all positions
├─ Circuit breaker checked
│  └─ If daily loss ≥ ₹3,000 → trading_enabled = false
├─ Telegram summary sent
│
3:30 PM IST
├─ Market closes
├─ Daily analytics calculated
└─ Waiting for next trading day
```

## Edge Functions Cron Schedule

```bash
# ORB Scanner: Every 5 minutes during 9:15-15:30 IST
*/5 3,4,5,6,7,8,9 * * 1-5

# Exit Handler: Every 1 minute during 9:30-15:30 IST
* 4,5,6,7,8,9 * * 1-5

# EOD Flatten: 3:15 PM IST
45 9 * * 1-5

# Health Check: Every 15 minutes during 9:15-15:30 IST
*/15 3,4,5,6,7,8,9 * * 1-5
```

## Test Coverage

| Module | Tests | Status |
|--------|-------|--------|
| ORB Scanner | 12 | ✅ Passing |
| Exit Handler | 14 | ✅ Passing |
| EOD Flatten | 7 | ✅ Passing |
| Telegram | 7 | ✅ Passing |
| Health Check | 11 | ✅ Passing |
| Indicators | 17 | ✅ Passing |
| **Total** | **73** | **✅ All Passing** |

## Implementation Details

### Position Sizing
```
Risk Amount: ₹1,000 (fixed)
Entry Price: Close + 0.05% slippage
Stop Loss: OR boundary
Target: Entry + (OR Range × 1.5)
Shares: floor(₹1,000 / (Entry - Stop))
```

### Exit Logic
```typescript
// Long trade
if (candle.low <= stop_loss_price) {
  exit with stop slippage → closing
} else if (candle.high >= target_price) {
  exit with target slippage → closing
}

// Short trade (reversed)
if (candle.high >= stop_loss_price) {
  exit with stop slippage → closing
} else if (candle.low <= target_price) {
  exit with target slippage → closing
}
```

### P&L Formula
```
Gross P&L = (Exit Price - Entry Price) × Shares  [for longs]
           (Entry Price - Exit Price) × Shares  [for shorts]

Statutory Charges = |Exit Price × Shares × 0.05%|
Brokerage = ₹20 × 2 (entry + exit)

Net P&L = Gross P&L - Statutory - Brokerage
```

## Monitoring & Alerts

### Telegram Notifications
- **On Entry**: Confirmation with entry price, target, stop
- **On Exit**: P&L outcome (profit/loss with breakdown)
- **Circuit Breaker**: Alert when daily loss triggers halt
- **Heartbeat**: Every 15 min with trading status
- **Errors**: Immediate notification on data staleness

### Dashboard Metrics
- Trading enabled toggle (kill switch)
- Open positions count
- Daily P&L running total
- Circuit breaker status
- Last heartbeat timestamp

## Known Limitations

1. **Market Hours Only**: Trades only during NSE hours (9:15-15:30 IST)
2. **No Partial Exits**: All-or-nothing closing at target/stop
3. **Single OR per Day**: Only one trade per instrument daily
4. **Mock Slippage**: Based on fixed percentages, not actual market impact
5. **No Gap Handling**: Assumes continuous price data

## Future Enhancements

- [ ] Multiple trades per instrument per day
- [ ] Partial position exits (trailing stops)
- [ ] Dynamic position sizing (Kelly criterion)
- [ ] ML-based stop/target optimization
- [ ] Multi-timeframe confluence signals
- [ ] Live trading integration (move from paper)

## Support & Documentation

- **Deployment**: See `DEPLOYMENT.md`
- **Configuration**: See `.env.example`
- **Indicators**: See `supabase/functions/_shared/indicators.ts`
- **Backtest**: Run `python3 quant-lab/backtest_orb_strategy.py`

---

**Version**: v1.0  
**Status**: Production Ready  
**Last Updated**: May 26, 2026
