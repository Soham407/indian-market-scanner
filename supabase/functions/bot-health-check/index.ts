import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";

const STALE_CANDLE_THRESHOLD_MINUTES = 5; // Alert if latest candle is >5 min old
const HEARTBEAT_INTERVAL_MINUTES = 15; // Send heartbeat every 15 min during market hours
const NIFTY_50_SYMBOLS = [
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
  "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BPCL", "BHARTIARTL",
  "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
  "EICHERMOT", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE",
  "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC",
  "INDUSINDBK", "INFY", "JSWSTEEL", "KOTAKBANK", "LTIM",
  "LT", "M&M", "MARUTI", "NTPC", "NESTLEIND",
  "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN",
  "SUNPHARMA", "TCS", "TATACONSUM", "TATAMOTORS", "TATASTEEL",
  "TECHM", "TITAN", "ULTRACEMCO", "UPL", "WIPRO",
] as const;

Deno.serve(async () => {
  const session = getMarketSessionStatus();
  if (!session.isOpen) {
    return Response.json({ status: "Market closed", health: "idle" });
  }

  const supabase = createServiceClient();
  const now = new Date();
  const nowMs = now.getTime();
  let staleCandlesDetected = 0;
  let staleInstruments: string[] = [];

  // Parse current IST minutes to determine time elapsed since open (9:15 AM IST)
  const [istHour, istMinute] = session.istTime.split(":").map(Number);
  const minutesSinceMidnight = istHour * 60 + istMinute;
  const marketOpenMinutes = 9 * 60 + 15;
  const minutesSinceOpen = minutesSinceMidnight - marketOpenMinutes;

  // Check for stale candle data
  for (const symbol of NIFTY_50_SYMBOLS) {
    const { data: instrument } = await supabase
      .from("instruments")
      .select("id")
      .eq("symbol", symbol)
      .eq("exchange", "NSE")
      .single();

    if (!instrument) continue;

    const { data: latestCandle } = await supabase
      .from("bot_candles")
      .select("candle_open_at")
      .eq("instrument_id", instrument.id)
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1)
      .single();

    if (!latestCandle) {
      // If we just opened today, don't trigger alert for missing candle immediately
      if (minutesSinceOpen >= 15) {
        staleInstruments.push(symbol);
        staleCandlesDetected++;
      }
      continue;
    }

    const candleDate = new Date(new Date(latestCandle.candle_open_at).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
    const todayIst = session.istDate;

    if (candleDate === todayIst) {
      // Candle is from today: check if older than threshold
      const candleAge = (nowMs - new Date(latestCandle.candle_open_at).getTime()) / 1000 / 60;
      if (candleAge > STALE_CANDLE_THRESHOLD_MINUTES) {
        staleInstruments.push(`${symbol} (${Math.floor(candleAge)}m old)`);
        staleCandlesDetected++;
      }
    } else {
      // Candle is from previous trading day:
      // Only count as stale if the market has been open for 15+ minutes today
      if (minutesSinceOpen >= 15) {
        staleInstruments.push(`${symbol} (no data today, last was ${candleDate})`);
        staleCandlesDetected++;
      }
    }
  }

  // Alert if stale data detected
  if (staleCandlesDetected > 5) {
    await sendTelegramNotification({
      type: "error",
      symbol: "STALE_DATA",
      timestamp: now.toISOString(),
      message: `Stale candle data detected for ${staleCandlesDetected} instruments: ${staleInstruments.slice(0, 5).join(", ")}...`,
    });
  }

  // Check trading status
  const { data: config } = await supabase
    .from("bot_config")
    .select("trading_enabled, circuit_breaker_triggered_at")
    .eq("id", 1)
    .single();

  const tradingEnabled = config?.trading_enabled ?? true;
  const circuitBreakerActive = !!config?.circuit_breaker_triggered_at;

  // Count open trades
  const { data: openTrades, count } = await supabase
    .from("bot_paper_trades")
    .select("id", { count: "exact" })
    .eq("status", "open");

  const openTradesCount = count ?? 0;

  // Fetch daily P&L
  const todayIst = now.toISOString().slice(0, 10);
  const { data: closedToday } = await supabase
    .from("bot_paper_trades")
    .select("net_pnl")
    .gte("exit_time", `${todayIst}T00:00:00Z`)
    .lt("exit_time", `${todayIst}T23:59:59Z`)
    .eq("status", "closed");

  let dailyPnl = 0;
  if (closedToday) {
    dailyPnl = closedToday.reduce((sum, t) => sum + (t.net_pnl || 0), 0);
  }

  // Send heartbeat — the cron fires every 15 min, so just always send when market is open.
  // (Avoids the DATE-column vs TIMESTAMPTZ comparison bug with last_trading_date.)
  const status = circuitBreakerActive
    ? "⛔ Circuit breaker active"
    : tradingEnabled
      ? `✅ Trading active (${openTradesCount} open)`
      : "🛑 Trading disabled";

  await sendTelegramNotification({
    type: "heartbeat",
    symbol: "BOT",
    timestamp: now.toISOString(),
    message: `${status} | Daily P&L: ₹${dailyPnl.toFixed(0)}`,
  });

  return Response.json({
    status: "Health check complete",
    health: staleCandlesDetected > 5 ? "degraded" : "healthy",
    stale_candles: staleCandlesDetected,
    open_trades: openTradesCount,
    daily_pnl: dailyPnl,
    trading_enabled: tradingEnabled,
    circuit_breaker_active: circuitBreakerActive,
  });
});
