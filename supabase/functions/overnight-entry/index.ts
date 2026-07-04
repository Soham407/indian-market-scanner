// overnight-entry — buys the validated basket near the close (~3:24 PM IST).
// Positions are held OVERNIGHT and squared off by overnight-exit at next open.
// eod-flatten is patched to skip these (strategy = overnight_hold).
//
// Edge basis: 22-symbol pooled PF 1.238 (2015-22 daily), OOS test PF 1.27
// (2022-26 intraday). See _shared/overnight.ts.
import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import { buildOvernightEntry } from "../_shared/overnight.ts";

const EXCHANGE = "NSE";
const ENTRY_TIME = 15 * 60 + 24;   // 3:24 PM IST — near close
const ENTRY_WINDOW_MINUTES = 6;    // run until 3:30 PM
const DEFAULT_RISK_AMOUNT = 1000;  // ₹ risk per name (fallback if bot_config unset)

// Strongest overnight names from the real-data validation (all PF > 1.25).
const OVERNIGHT_BASKET = [
  "BAJFINANCE", "ADANIPORTS", "SBIN", "ONGC", "SUNPHARMA",
  "RELIANCE", "TITAN", "NESTLEIND", "TATASTEEL", "MARUTI",
];

function istMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

Deno.serve(async () => {
  const session = getMarketSessionStatus();
  if (!session.isOpen) return Response.json({ status: "Market closed", entries: 0 });

  const now = new Date();
  const m = istMinutes(now);
  if (m < ENTRY_TIME || m >= ENTRY_TIME + ENTRY_WINDOW_MINUTES) {
    return Response.json({ status: "Not entry window", entries: 0 });
  }

  const supabase = createServiceClient();
  const todayIst = istDateStr(now);

  // Resolve the overnight strategy row (seeded by migration).
  const { data: strat } = await supabase
    .from("bot_strategies")
    .select("id,enabled,risk_multiplier")
    .eq("name", "overnight_hold")
    .maybeSingle();
  if (!strat || strat.enabled === false) {
    return Response.json({ status: "overnight_hold strategy disabled/missing", entries: 0 });
  }
  const riskAmount = DEFAULT_RISK_AMOUNT * Number(strat.risk_multiplier ?? 1);

  const { data: instruments } = await supabase
    .from("instruments")
    .select("id,symbol")
    .eq("exchange", EXCHANGE)
    .in("symbol", OVERNIGHT_BASKET);
  if (!instruments || instruments.length === 0) {
    return Response.json({ status: "no basket instruments found", entries: 0 });
  }

  let entries = 0;
  const placed: string[] = [];
  for (const inst of instruments) {
    // Idempotency: at most one open overnight position per instrument.
    const { data: existing } = await supabase
      .from("bot_paper_trades")
      .select("id")
      .eq("instrument_id", inst.id)
      .eq("strategy_id", strat.id)
      .eq("status", "open")
      .limit(1);
    if (existing && existing.length > 0) continue;

    // Entry price = latest 1-min candle close (near the market close).
    const { data: candles } = await supabase
      .from("bot_candles")
      .select("close")
      .eq("instrument_id", inst.id)
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1);
    const closePx = candles && candles.length > 0 ? Number(candles[0].close) : null;
    if (!closePx || closePx <= 0) continue;

    const entry = buildOvernightEntry(closePx, riskAmount);
    if (!entry) continue;

    const { error } = await supabase.from("bot_paper_trades").insert({
      strategy_id: strat.id,
      instrument_id: inst.id,
      side: entry.side,
      entry_price: entry.entry_price,
      entry_time: now.toISOString(),
      entry_slippage_pct: entry.entry_slippage_pct,
      stop_loss_price: entry.stop_loss_price,
      target_price: entry.target_price,
      shares: entry.shares,
      risk_amount: entry.risk_amount,
      status: "open",
    });
    if (error) {
      console.error(`[overnight-entry] insert failed for ${inst.symbol}:`, error.message);
      continue;
    }
    entries++;
    placed.push(`${inst.symbol} ${entry.shares}@${entry.entry_price}`);
  }

  if (entries > 0) {
    await sendTelegramNotification({
      type: "heartbeat",
      symbol: "OVERNIGHT",
      timestamp: now.toISOString(),
      message: `🌙 Overnight entry — ${entries} position(s) opened for ${todayIst}:\n${placed.join("\n")}`,
    });
  }

  return Response.json({ status: "overnight entry complete", entries, placed });
});
