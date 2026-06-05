// Runs at 3:30 PM IST (10:00 AM UTC) — after the market closes and eod-flatten has settled.
// Sends a full day summary to Telegram: P&L, trade-by-trade, wins/losses, circuit breaker status.

import { createServiceClient } from "../_shared/supabase.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";

const DAILY_LOSS_CIRCUIT_BREAKER = -3000;

function istDateStr(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function istDateDisplay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function rs(n: number, decimals = 0): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}₹${Math.abs(n).toFixed(decimals)}`;
}

function exitEmoji(reason: string | null, pnl: number): string {
  if (reason === "target") return "✅";
  if (reason === "stop")   return "❌";
  return pnl >= 1 ? "⬜" : pnl <= -1 ? "🔻" : "⬜";
}

Deno.serve(async () => {
  const supabase = createServiceClient();
  const now = new Date();
  const todayIst = istDateStr(now);

  // Fetch all trades closed today (by exit_time)
  const { data: closedToday, error } = await supabase
    .from("bot_paper_trades")
    .select(
      "side,entry_price,exit_price,shares,gross_pnl,net_pnl,brokerage,statutory_charges,exit_reason,instruments(symbol,name)"
    )
    .gte("exit_time", `${todayIst}T00:00:00Z`)
    .lt("exit_time", `${todayIst}T23:59:59Z`)
    .eq("status", "closed")
    .order("net_pnl", { ascending: false });

  if (error) {
    return Response.json({ error: error.message });
  }

  type Trade = {
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

  const trades = (closedToday ?? []) as Trade[];

  // Any positions still open (shouldn't be, but surface them)
  const { data: stillOpen } = await supabase
    .from("bot_paper_trades")
    .select("side,entry_price,instruments(symbol)")
    .eq("status", "open");

  // Aggregate stats
  const totalGross = trades.reduce((s, t) => s + (t.gross_pnl ?? 0), 0);
  const totalNet   = trades.reduce((s, t) => s + (t.net_pnl ?? 0), 0);
  const totalBrok  = trades.reduce((s, t) => s + (t.brokerage ?? 0), 0);
  const totalStat  = trades.reduce((s, t) => s + (t.statutory_charges ?? 0), 0);
  const wins   = trades.filter((t) => (t.net_pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.net_pnl ?? 0) < 0).length;
  const flat   = trades.length - wins - losses;
  const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0;

  const circuitTripped = totalNet <= DAILY_LOSS_CIRCUIT_BREAKER;

  // Check bot_settings to see if circuit breaker is already active
  const { data: config } = await supabase
    .from("bot_settings")
    .select("trading_enabled, kill_switch_reason")
    .eq("id", 1)
    .single();
  const tradingEnabled = config?.trading_enabled ?? true;

  // --- Build message ---
  const pnlLine  = `${totalNet >= 0 ? "🟢" : "🔴"} NET P&L:    ${rs(totalNet)}`;
  const grossLine = `   Gross:      ${rs(totalGross)}`;
  const costLine  = `   Charges:   -₹${(totalBrok + totalStat).toFixed(0)} (brokerage + STT)`;

  // Trade log — cap at 20 lines to stay within Telegram 4096-char limit
  const tradeLines = trades.slice(0, 20).map((t) => {
    const tradeInst = Array.isArray(t.instruments) ? t.instruments[0] : t.instruments;
    const sym    = tradeInst?.symbol ?? "???";
    const side   = t.side === "long" ? "L" : "S";
    const pnl    = t.net_pnl ?? 0;
    const reason = t.exit_reason ?? "eod";
    return `  ${exitEmoji(reason, pnl)} ${sym.padEnd(12)} ${side}  ${rs(pnl).padStart(8)}  (${reason})`;
  });
  if (trades.length > 20) {
    tradeLines.push(`  … and ${trades.length - 20} more`);
  }

  const openSection = stillOpen && stillOpen.length > 0
    ? (stillOpen as { instruments: { symbol: string }[] | { symbol: string } | null; side: string }[])
        .map((t) => {
          const inst = Array.isArray(t.instruments) ? t.instruments[0] : t.instruments;
          return `  ⚠️ ${inst?.symbol ?? "?"} ${t.side} — STILL OPEN`;
        })
        .join("\n")
    : "  None — all squared off ✅";

  const tomorrowLine = !tradingEnabled
    ? "⛔ Circuit breaker active — bot PAUSED\n  Re-enable: set trading_enabled=true in bot_settings"
    : "✅ Bot resumes at 9:15 AM IST";

  const bestTrade  = trades[0];
  const worstTrade = trades[trades.length - 1];
  const bestTradeInst = bestTrade ? (Array.isArray(bestTrade.instruments) ? bestTrade.instruments[0] : bestTrade.instruments) : null;
  const worstTradeInst = worstTrade ? (Array.isArray(worstTrade.instruments) ? worstTrade.instruments[0] : worstTrade.instruments) : null;
  const bestLine  = bestTrade  ? `🏆 Best:   ${bestTradeInst?.symbol}  ${rs(bestTrade.net_pnl ?? 0)}` : "";
  const worstLine = worstTrade ? `💀 Worst:  ${worstTradeInst?.symbol}  ${rs(worstTrade.net_pnl ?? 0)}` : "";

  const msg = [
    `📊 Day Summary — ${istDateDisplay(todayIst)}`,
    ``,
    pnlLine,
    grossLine,
    costLine,
    ``,
    `🎯 Win Rate: ${wins}W / ${losses}L / ${flat}E  (${winRate}%)`,
    bestLine,
    worstLine,
    ``,
    trades.length > 0 ? `📋 Trades (${trades.length})` : `📋 No trades today`,
    ...tradeLines,
    ``,
    `🔒 Open Positions`,
    openSection,
    ``,
    `📅 Tomorrow`,
    `  ${tomorrowLine}`,
  ].filter(Boolean).join("\n");

  await sendTelegramNotification({
    type: "eod_summary",
    symbol: "EOD",
    timestamp: now.toISOString(),
    message: msg,
  });

  return Response.json({
    status: "EOD summary sent",
    date: todayIst,
    trades: trades.length,
    wins,
    losses,
    gross_pnl: totalGross,
    net_pnl: totalNet,
    circuit_breaker: circuitTripped,
    trading_enabled: tradingEnabled,
  });
});
