import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";

const EXCHANGE = "NSE";
const OR_WINDOW_END = 9 * 60 + 30; // 9:30 IST in minutes since midnight
const OR_WINDOW_START = 9 * 60 + 15; // 9:15 IST
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

function istMinutesSinceMidnight(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isOrWindow(now = new Date()): boolean {
  const minutes = istMinutesSinceMidnight(now);
  return minutes >= OR_WINDOW_START && minutes < OR_WINDOW_END;
}

function isBreakoutWindow(now = new Date()): boolean {
  const minutes = istMinutesSinceMidnight(now);
  return minutes >= OR_WINDOW_END && minutes < 15 * 60 + 30; // 9:30-15:30 IST
}

type BotInstrument = {
  id: string;
  symbol: string;
  or_high: number | null;
  or_low: number | null;
  or_date: string | null;
  session_high: number | null;
  session_low: number | null;
};

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  candle_open_at: string;
};

Deno.serve(async () => {
  const session = getMarketSessionStatus();
  if (!session.isOpen) {
    return Response.json({ status: "Market closed", trades_placed: 0 });
  }

  const supabase = createServiceClient();
  const now = new Date();

  // Phase 1: Build opening range during 9:15-9:30
  if (isOrWindow(now)) {
    const { data: instruments } = await supabase
      .from("instruments")
      .select("id,symbol,or_high,or_low,or_date")
      .eq("exchange", EXCHANGE)
      .in("symbol", [...NIFTY_50_SYMBOLS]);

    if (!instruments) {
      return Response.json({ status: "Failed to fetch instruments", trades_placed: 0 });
    }

    const todayIst = now.toISOString().slice(0, 10);
    let orUpdated = 0;

    for (const inst of instruments) {
      // Skip if OR already built for today
      if (inst.or_date === todayIst && inst.or_high && inst.or_low) {
        continue;
      }

      const { data: candles } = await supabase
        .from("bot_candles")
        .select("high,low,close,volume")
        .eq("instrument_id", inst.id)
        .eq("timeframe", "1m")
        .gte("candle_open_at", `${todayIst}T03:45:00Z`) // 9:15 IST
        .lt("candle_open_at", `${todayIst}T04:00:00Z`) // 9:30 IST
        .order("candle_open_at", { ascending: true });

      if (!candles || candles.length === 0) continue;

      const orHigh = Math.max(...candles.map((c) => c.high));
      const orLow = Math.min(...candles.map((c) => c.low));

      await supabase
        .from("instruments")
        .update({ or_high: orHigh, or_low: orLow, or_date: todayIst })
        .eq("id", inst.id);

      orUpdated++;
    }

    return Response.json({ status: "OR window", or_updated: orUpdated, trades_placed: 0 });
  }

  // Phase 2: Detect breakouts after 9:30
  if (!isBreakoutWindow(now)) {
    return Response.json({ status: "Before breakout window", trades_placed: 0 });
  }

  const { data: instruments } = await supabase
    .from("instruments")
    .select("id,symbol,name,or_high,or_low,or_date")
    .eq("exchange", EXCHANGE)
    .in("symbol", [...NIFTY_50_SYMBOLS]);

  if (!instruments) {
    return Response.json({ status: "Failed to fetch instruments", trades_placed: 0 });
  }

  const todayIst = now.toISOString().slice(0, 10);
  let tradesPlaced = 0;
  const volumeMultiplier = 1.5;

  for (const inst of instruments) {
    if (!inst.or_high || !inst.or_low || inst.or_date !== todayIst) continue;

    // Check if trade already exists for today
    const { data: existingTrades } = await supabase
      .from("bot_paper_trades")
      .select("id")
      .eq("instrument_id", inst.id)
      .gte("entry_time", `${todayIst}T00:00:00Z`)
      .lt("entry_time", `${todayIst}T23:59:59Z`);

    if (existingTrades && existingTrades.length > 0) {
      continue; // Already have a trade for this instrument today
    }

    // Get latest candle
    const { data: candles } = await supabase
      .from("bot_candles")
      .select("close,high,low,volume,candle_open_at")
      .eq("instrument_id", inst.id)
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1);

    if (!candles || candles.length === 0) continue;

    const latestCandle = candles[0];
    const orRange = inst.or_high - inst.or_low;
    const targetPrice = 0; // Will be set per strategy

    // Long breakout: close above OR high with volume
    if (latestCandle.close > inst.or_high && latestCandle.volume >= volumeMultiplier * 10000) {
      const side = "long";
      const entryPrice = latestCandle.close;
      const stopPrice = inst.or_low;
      const targetPriceCalc = entryPrice + orRange * 1.5;

      // Calculate position size: ₹1000 risk / (entry - stop)
      const riskPerTrade = 1000;
      const shares = Math.floor(riskPerTrade / (entryPrice - stopPrice));

      if (shares > 0) {
        const entrySlippage = entryPrice * 0.0005; // 0.05%
        const actualEntry = entryPrice + entrySlippage;

        const { error: insertError } = await supabase
          .from("bot_paper_trades")
          .insert({
            strategy_id: "orb_breakout",
            instrument_id: inst.id,
            side,
            entry_price: actualEntry,
            entry_time: new Date().toISOString(),
            entry_slippage_pct: 0.05,
            stop_loss_price: stopPrice,
            target_price: targetPriceCalc,
            shares,
            status: "open",
            risk_amount: riskPerTrade,
          });

        if (!insertError) {
          tradesPlaced++;
          await sendTelegramNotification({
            type: "entry",
            symbol: `${inst.symbol} (${inst.name})`,
            side: "long",
            entryPrice: actualEntry,
            targetPrice: targetPriceCalc,
            stopLossPrice: stopPrice,
            riskAmount: riskPerTrade,
            shares,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Short breakout: close below OR low with volume
    if (latestCandle.close < inst.or_low && latestCandle.volume >= volumeMultiplier * 10000) {
      const side = "short";
      const entryPrice = latestCandle.close;
      const stopPrice = inst.or_high;
      const targetPriceCalc = entryPrice - orRange * 1.5;

      const riskPerTrade = 1000;
      const shares = Math.floor(riskPerTrade / (stopPrice - entryPrice));

      if (shares > 0) {
        const entrySlippage = entryPrice * 0.0005;
        const actualEntry = entryPrice - entrySlippage;

        const { error: insertError } = await supabase
          .from("bot_paper_trades")
          .insert({
            strategy_id: "orb_breakout",
            instrument_id: inst.id,
            side,
            entry_price: actualEntry,
            entry_time: new Date().toISOString(),
            entry_slippage_pct: 0.05,
            stop_loss_price: stopPrice,
            target_price: targetPriceCalc,
            shares,
            status: "open",
            risk_amount: riskPerTrade,
          });

        if (!insertError) {
          tradesPlaced++;
          await sendTelegramNotification({
            type: "entry",
            symbol: `${inst.symbol} (${inst.name})`,
            side: "short",
            entryPrice: actualEntry,
            targetPrice: targetPriceCalc,
            stopLossPrice: stopPrice,
            riskAmount: riskPerTrade,
            shares,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }

  return Response.json({ status: "Breakout detection", trades_placed: tradesPlaced });
});
