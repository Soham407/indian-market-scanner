import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";

const EOD_TIME = 15 * 60 + 15;             // 3:15 PM IST
const EOD_WINDOW_MINUTES = 20;             // run up to 3:35 PM
const DAILY_LOSS_CIRCUIT_BREAKER = -3000;  // ₹3,000
const BROKERAGE_PER_TRADE = 40;            // ₹20 per leg × 2
const STATUTORY_FEE_PCT = 0.0005;          // 0.05%
const EOD_EXIT_SLIPPAGE_PCT = 0.0005;      // 0.05%

function istMinutesSinceMidnight(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isEodWindow(now = new Date()): boolean {
  const m = istMinutesSinceMidnight(now);
  return m >= EOD_TIME && m < EOD_TIME + EOD_WINDOW_MINUTES;
}

function istDateStr(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
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
  const todayIst = istDateStr(now);
  let tradesFlattened = 0;

  // -------------------------------------------------------------------------
  // 1. Fetch all open trades with full detail for flatten + summary
  // -------------------------------------------------------------------------
  const { data: openTrades, error: tradesError } = await supabase
    .from("bot_paper_trades")
    .select("id,instrument_id,side,entry_price,entry_time,shares,stop_loss_price,target_price,risk_amount,instruments(symbol,name,last_price)")
    .eq("status", "open");

  if (tradesError) {
    return Response.json({ error: tradesError.message, trades_flattened: 0 });
  }

  // -------------------------------------------------------------------------
  // 2. Close each open trade at the last known price
  // -------------------------------------------------------------------------
  for (const trade of (openTrades ?? [])) {
    // Try latest 1-min candle; fall back to instruments.last_price
    const { data: candles } = await supabase
      .from("bot_candles")
      .select("close")
      .eq("instrument_id", trade.instrument_id)   // ← was incorrectly trade.id
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1);

    const inst = Array.isArray(trade.instruments)
      ? trade.instruments[0]
      : trade.instruments as { symbol: string; name: string; last_price: number | null } | null;
    const eodPrice: number | null =
      (candles && candles.length > 0 ? candles[0].close : null)
      ?? inst?.last_price
      ?? null;

    if (!eodPrice || eodPrice <= 0) continue;

    const exitPriceWithSlippage = trade.side === "long"
      ? eodPrice * (1 - EOD_EXIT_SLIPPAGE_PCT)
      : eodPrice * (1 + EOD_EXIT_SLIPPAGE_PCT);

    const grossPnl = trade.side === "long"
      ? (exitPriceWithSlippage - trade.entry_price) * trade.shares
      : (trade.entry_price - exitPriceWithSlippage) * trade.shares;

    const statutoryCharges = Math.abs(exitPriceWithSlippage * trade.shares * STATUTORY_FEE_PCT);
    const netPnl = grossPnl - statutoryCharges - BROKERAGE_PER_TRADE;

    const { error: updateError } = await supabase
      .from("bot_paper_trades")
      .update({
        exit_price: exitPriceWithSlippage,
        exit_time: now.toISOString(),
        exit_reason: "eod",           // ← was "eod_flatten" which violates the check constraint
        status: "closed",
        gross_pnl: grossPnl,
        brokerage: BROKERAGE_PER_TRADE,
        statutory_charges: statutoryCharges,
        net_pnl: netPnl,
      })
      .eq("id", trade.id);

    if (updateError) {
      console.error("[eod-flatten] failed to update bot_paper_trades:", updateError.message);
      continue;
    }

    const exitTimeIso = now.toISOString();
    const durationMinutes = Math.max(
      0,
      Math.round((new Date(exitTimeIso).getTime() - new Date(trade.entry_time).getTime()) / 60000),
    );
    const rMultiple = trade.risk_amount > 0 ? netPnl / trade.risk_amount : null;

    const { error: outcomeError } = await supabase
      .from("bot_signal_outcomes")
      .update({
        exit_price: exitPriceWithSlippage,
        exit_reason: "eod",
        gross_pnl: grossPnl,
        net_pnl: netPnl,
        r_multiple: rMultiple,
        duration_minutes: durationMinutes,
        status: "closed",
        closed_at: exitTimeIso,
      })
      .eq("paper_trade_id", trade.id);

    if (outcomeError) {
      console.error("[eod-flatten] failed to update bot_signal_outcomes:", outcomeError.message);
      continue;
    }

    tradesFlattened++;
  }

  // -------------------------------------------------------------------------
  // 3. Fetch all trades closed today (including the ones we just closed)
  // -------------------------------------------------------------------------
  const { data: closedToday } = await supabase
    .from("bot_paper_trades")
    .select("side,entry_price,exit_price,shares,gross_pnl,net_pnl,brokerage,statutory_charges,exit_reason,instruments(symbol,name)")
    .gte("exit_time", `${todayIst}T00:00:00Z`)
    .lt("exit_time", `${todayIst}T23:59:59Z`)
    .eq("status", "closed")
    .order("net_pnl", { ascending: false });

  type ClosedTrade = {
    side: string;
    entry_price: number;
    exit_price: number | null;
    shares: number;
    gross_pnl: number | null;
    net_pnl: number | null;
    brokerage: number | null;
    statutory_charges: number | null;
    exit_reason: string | null;
    instruments: { symbol: string; name: string }[] | { symbol: string; name: string } | null;
  };

  const trades = (closedToday ?? []) as ClosedTrade[];
  const totalGross = trades.reduce((s, t) => s + (t.gross_pnl ?? 0), 0);
  const totalNet   = trades.reduce((s, t) => s + (t.net_pnl ?? 0), 0);
  const totalBrok  = trades.reduce((s, t) => s + (t.brokerage ?? 0), 0);
  const totalStat  = trades.reduce((s, t) => s + (t.statutory_charges ?? 0), 0);

  const wins   = trades.filter((t) => (t.net_pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.net_pnl ?? 0) < 0).length;
  const flat   = trades.length - wins - losses;
  const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0;

  // -------------------------------------------------------------------------
  // 4. Check for any positions still open (shouldn't be, but just in case)
  // -------------------------------------------------------------------------
  const { data: stillOpen } = await supabase
    .from("bot_paper_trades")
    .select("instruments(symbol),side")
    .eq("status", "open");

  // -------------------------------------------------------------------------
  // 5. Circuit breaker check
  // -------------------------------------------------------------------------
  if (totalNet <= DAILY_LOSS_CIRCUIT_BREAKER) {
    await supabase
      .from("bot_config")
      .update({
        circuit_breaker_triggered_at: now.toISOString(),
      })
      .eq("id", 1);

    await sendTelegramNotification({
      type: "circuit_breaker",
      symbol: "BOT",
      timestamp: now.toISOString(),
      message: `Daily loss ₹${totalNet.toFixed(0)} exceeded ₹3,000 limit`,
    });
  }

  // Note: the full EOD Telegram summary is sent by the separate eod-summary
  // function which runs at 3:30 PM IST (10:00 AM UTC), after all positions
  // are settled and the market has fully closed.

  return Response.json({
    status: "EOD flatten complete",
    trades_flattened: tradesFlattened,
    total_trades_today: trades.length,
    wins,
    losses,
    gross_pnl: totalGross,
    net_pnl: totalNet,
    circuit_breaker: totalNet <= DAILY_LOSS_CIRCUIT_BREAKER,
  });
});
