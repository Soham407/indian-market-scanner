import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";

const EXCHANGE = "NSE";
const OR_WINDOW_START   = 9 * 60 + 15;  // 9:15 IST
const OR_WINDOW_END     = 9 * 60 + 30;  // 9:30 IST
const BREAKOUT_CUTOFF   = 12 * 60 + 30; // 12:30 IST — no new entries after this
const MAX_TRADES_PER_DAY = 6;           // cap daily friction costs
const RISK_PER_TRADE    = 1000;         // ₹1,000 per trade
const TARGET_MULTIPLIER = 1.5;          // target = entry ± OR_range × 1.5
const BREAKOUT_BUFFER   = 0.003;        // 0.3% above/below OR before triggering
const MIN_OR_RANGE_PCT  = 0.003;        // OR must be at least 0.3% of price
const MAX_OR_RANGE_PCT  = 0.05;         // OR must be at most 5% of price
const MIN_AVG_MIN_VOLUME = 15_000;      // min avg shares/min (sessions ~1 crore/day ÷ 375 min ≈ 26K)

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

function istMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isOrWindow(now = new Date()): boolean {
  const m = istMinutes(now);
  return m >= OR_WINDOW_START && m < OR_WINDOW_END;
}

function isBreakoutWindow(now = new Date()): boolean {
  const m = istMinutes(now);
  return m >= OR_WINDOW_END && m < BREAKOUT_CUTOFF;
}

function istDateStr(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

type BotInstrument = {
  id: string;
  symbol: string;
  name: string;
  or_high: number | null;
  or_low: number | null;
  or_date: string | null;
  session_volume: number | null;
};

Deno.serve(async () => {
  const session = getMarketSessionStatus();
  if (!session.isOpen) {
    return Response.json({ status: "Market closed", trades_placed: 0 });
  }

  const supabase = createServiceClient();
  const now = new Date();
  const todayIst = istDateStr(now);

  // Resolve strategy UUID once
  const { data: strategyRow } = await supabase
    .from("bot_strategies")
    .select("id")
    .eq("name", "orb_breakout")
    .eq("status", "active")
    .single();

  if (!strategyRow?.id) {
    return Response.json({ error: "orb_breakout strategy not found", trades_placed: 0 }, { status: 500 });
  }
  const strategyUuid = strategyRow.id as string;

  // -------------------------------------------------------------------------
  // Phase 1: Build opening range from 9:15–9:30 candles
  // -------------------------------------------------------------------------
  if (isOrWindow(now)) {
    const { data: instruments } = await supabase
      .from("instruments")
      .select("id,symbol,or_high,or_low,or_date")
      .eq("exchange", EXCHANGE)
      .in("symbol", [...NIFTY_50_SYMBOLS]);

    if (!instruments) return Response.json({ status: "Failed to fetch instruments", trades_placed: 0 });

    let orUpdated = 0;
    for (const inst of instruments) {
      if (inst.or_date === todayIst && inst.or_high && inst.or_low) continue;

      const { data: candles } = await supabase
        .from("bot_candles")
        .select("high,low")
        .eq("instrument_id", inst.id)
        .eq("timeframe", "1m")
        .gte("candle_open_at", `${todayIst}T03:45:00Z`) // 9:15 IST
        .lt("candle_open_at", `${todayIst}T04:00:00Z`)  // 9:30 IST
        .order("candle_open_at", { ascending: true });

      if (!candles || candles.length === 0) continue;

      const orHigh = Math.max(...candles.map((c) => c.high));
      const orLow  = Math.min(...candles.map((c) => c.low));
      await supabase.from("instruments")
        .update({ or_high: orHigh, or_low: orLow, or_date: todayIst })
        .eq("id", inst.id);
      orUpdated++;
    }
    return Response.json({ status: "OR window", or_updated: orUpdated, trades_placed: 0 });
  }

  // -------------------------------------------------------------------------
  // Phase 2: Breakout detection — 9:30 AM to 12:30 PM only
  // -------------------------------------------------------------------------
  if (!isBreakoutWindow(now)) {
    const reason = istMinutes(now) < OR_WINDOW_END
      ? "Before breakout window"
      : "After 12:30 PM cutoff — no new entries";
    return Response.json({ status: reason, trades_placed: 0 });
  }

  // Guard: check daily trade cap
  const { count: tradesToday } = await supabase
    .from("bot_paper_trades")
    .select("id", { count: "exact", head: true })
    .gte("entry_time", `${todayIst}T00:00:00Z`)
    .lt("entry_time", `${todayIst}T23:59:59Z`);

  if ((tradesToday ?? 0) >= MAX_TRADES_PER_DAY) {
    return Response.json({ status: `Daily cap of ${MAX_TRADES_PER_DAY} trades reached`, trades_placed: 0 });
  }

  const remaining = MAX_TRADES_PER_DAY - (tradesToday ?? 0);

  const { data: instruments } = await supabase
    .from("instruments")
    .select("id,symbol,name,or_high,or_low,or_date,session_volume")
    .eq("exchange", EXCHANGE)
    .in("symbol", [...NIFTY_50_SYMBOLS]);

  if (!instruments) return Response.json({ status: "Failed to fetch instruments", trades_placed: 0 });

  // Minutes elapsed since market open (for per-minute volume estimate)
  const marketMinutesElapsed = Math.max(1, istMinutes(now) - OR_WINDOW_START);

  let tradesPlaced = 0;

  for (const inst of instruments as BotInstrument[]) {
    if (tradesPlaced >= remaining) break;
    if (!inst.or_high || !inst.or_low || inst.or_date !== todayIst) continue;

    // --- OR quality filter: ignore too-tight or too-wide ranges ---
    const orRange = inst.or_high - inst.or_low;
    const midPrice = (inst.or_high + inst.or_low) / 2;
    const orRangePct = orRange / midPrice;
    if (orRangePct < MIN_OR_RANGE_PCT || orRangePct > MAX_OR_RANGE_PCT) continue;

    // --- Volume filter: per-minute average from session volume ---
    const avgMinVol = (inst.session_volume ?? 0) / marketMinutesElapsed;
    if (avgMinVol < MIN_AVG_MIN_VOLUME) continue;

    // --- One trade per symbol per day ---
    const { data: existingTrades } = await supabase
      .from("bot_paper_trades")
      .select("id")
      .eq("instrument_id", inst.id)
      .gte("entry_time", `${todayIst}T00:00:00Z`)
      .lt("entry_time", `${todayIst}T23:59:59Z`);
    if (existingTrades && existingTrades.length > 0) continue;

    // --- Get latest candle for current price ---
    const { data: candles } = await supabase
      .from("bot_candles")
      .select("close,volume,candle_open_at")
      .eq("instrument_id", inst.id)
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1);

    if (!candles || candles.length === 0) continue;
    const latestClose = candles[0].close;

    // --- Breakout with 0.3% buffer (avoids noise at the boundary) ---
    const longTrigger  = inst.or_high * (1 + BREAKOUT_BUFFER);
    const shortTrigger = inst.or_low  * (1 - BREAKOUT_BUFFER);

    // ---- LONG breakout ----
    if (latestClose > longTrigger) {
      const entryPrice   = latestClose * 1.0005; // 0.05% entry slippage
      const stopPrice    = inst.or_low;
      const riskPerShare = entryPrice - stopPrice;
      if (riskPerShare <= 0) continue;
      const shares       = Math.floor(RISK_PER_TRADE / riskPerShare);
      if (shares <= 0) continue;
      const targetPrice  = entryPrice + orRange * TARGET_MULTIPLIER;

      const { error } = await supabase.from("bot_paper_trades").insert({
        strategy_id: strategyUuid,
        instrument_id: inst.id,
        side: "long",
        entry_price: entryPrice,
        entry_time: now.toISOString(),
        entry_slippage_pct: 0.05,
        stop_loss_price: stopPrice,
        target_price: targetPrice,
        shares,
        status: "open",
        risk_amount: RISK_PER_TRADE,
      });

      if (!error) {
        tradesPlaced++;
        await sendTelegramNotification({
          type: "entry",
          symbol: `${inst.symbol} (${inst.name})`,
          side: "long",
          entryPrice,
          targetPrice,
          stopLossPrice: stopPrice,
          riskAmount: RISK_PER_TRADE,
          shares,
          timestamp: now.toISOString(),
        });
      }
    }

    // ---- SHORT breakout ----
    else if (latestClose < shortTrigger) {
      const entryPrice   = latestClose * 0.9995; // 0.05% entry slippage
      const stopPrice    = inst.or_high;
      const riskPerShare = stopPrice - entryPrice;
      if (riskPerShare <= 0) continue;
      const shares       = Math.floor(RISK_PER_TRADE / riskPerShare);
      if (shares <= 0) continue;
      const targetPrice  = entryPrice - orRange * TARGET_MULTIPLIER;

      const { error } = await supabase.from("bot_paper_trades").insert({
        strategy_id: strategyUuid,
        instrument_id: inst.id,
        side: "short",
        entry_price: entryPrice,
        entry_time: now.toISOString(),
        entry_slippage_pct: 0.05,
        stop_loss_price: stopPrice,
        target_price: targetPrice,
        shares,
        status: "open",
        risk_amount: RISK_PER_TRADE,
      });

      if (!error) {
        tradesPlaced++;
        await sendTelegramNotification({
          type: "entry",
          symbol: `${inst.symbol} (${inst.name})`,
          side: "short",
          entryPrice,
          targetPrice,
          stopLossPrice: stopPrice,
          riskAmount: RISK_PER_TRADE,
          shares,
          timestamp: now.toISOString(),
        });
      }
    }
  }

  return Response.json({ status: "Breakout detection", trades_placed: tradesPlaced });
});
