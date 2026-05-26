import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";

const EOD_TIME = 15 * 60 + 15; // 3:15 PM IST in minutes since midnight
const DAILY_LOSS_CIRCUIT_BREAKER = -3000; // -₹3000 = -3%
const SESSION_START = 9 * 60 + 15; // 9:15 IST

function istMinutesSinceMidnight(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isEodWindow(now = new Date()): boolean {
  const minutes = istMinutesSinceMidnight(now);
  return minutes >= EOD_TIME && minutes < EOD_TIME + 15;
}

Deno.serve(async () => {
  const session = getMarketSessionStatus();
  if (!session.isOpen) {
    return Response.json({ status: "Market closed", trades_flattened: 0 });
  }

  const now = new Date();
  if (!isEodWindow(now)) {
    return Response.json({ status: "Not EOD window", trades_flattened: 0 });
  }

  const supabase = createServiceClient();
  const todayIst = now.toISOString().slice(0, 10);
  let tradesFlattened = 0;

  // Fetch all open trades
  const { data: openTrades, error: tradesError } = await supabase
    .from("bot_paper_trades")
    .select("id,side,entry_price,shares,stop_loss_price")
    .eq("status", "open");

  if (tradesError || !openTrades) {
    return Response.json({
      error: tradesError?.message,
      trades_flattened: 0,
    });
  }

  // Close all open trades at current market price (use close of last candle as EOD price)
  for (const trade of openTrades) {
    const { data: candles } = await supabase
      .from("bot_candles")
      .select("close")
      .eq("instrument_id", trade.id)
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1);

    if (!candles || candles.length === 0) continue;

    const eodPrice = candles[0].close;
    const grossPnl = trade.side === "long"
      ? (eodPrice - trade.entry_price) * trade.shares
      : (trade.entry_price - eodPrice) * trade.shares;

    const statutoryCharges = Math.abs(eodPrice * trade.shares * 0.0005); // 0.05%
    const brokerage = 40; // ₹20 per leg × 2
    const netPnl = grossPnl - statutoryCharges - brokerage;

    const { error: updateError } = await supabase
      .from("bot_paper_trades")
      .update({
        exit_price: eodPrice,
        exit_time: now.toISOString(),
        exit_reason: "eod_flatten",
        status: "closed",
        gross_pnl: grossPnl,
        brokerage,
        statutory_charges: statutoryCharges,
        net_pnl: netPnl,
      })
      .eq("id", trade.id);

    if (!updateError) {
      tradesFlattened++;
    }
  }

  // Calculate daily P&L and check circuit breaker
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

  // Trigger circuit breaker if daily loss exceeds ₹3000
  if (dailyPnl <= DAILY_LOSS_CIRCUIT_BREAKER) {
    await supabase
      .from("bot_config")
      .update({ trading_enabled: false, circuit_breaker_triggered_at: now.toISOString() })
      .eq("id", 1); // Assuming single config row

    await sendTelegramNotification({
      type: "circuit_breaker",
      symbol: "BOT",
      timestamp: now.toISOString(),
      message: `Daily loss ₹${dailyPnl.toFixed(0)} exceeded ₹3,000 limit`,
    });

    return Response.json({
      status: "Circuit breaker triggered",
      trades_flattened: tradesFlattened,
      daily_pnl: dailyPnl,
      trading_enabled: false,
    });
  }

  return Response.json({
    status: "EOD flatten complete",
    trades_flattened: tradesFlattened,
    daily_pnl: dailyPnl,
  });
});
