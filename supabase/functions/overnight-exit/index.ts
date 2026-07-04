// overnight-exit — sells the overnight basket at the next day's open (~9:17 AM IST).
// Closes every open overnight_hold position at today's first 1-min candle open.
import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import { settleOvernight } from "../_shared/overnight.ts";

const EXIT_TIME = 9 * 60 + 17;    // 9:17 AM IST — just after the open prints
const EXIT_WINDOW_MINUTES = 8;    // run until 9:25 AM

function istMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

Deno.serve(async () => {
  const session = getMarketSessionStatus();
  if (!session.isOpen) return Response.json({ status: "Market closed", exits: 0 });

  const now = new Date();
  const m = istMinutes(now);
  if (m < EXIT_TIME || m >= EXIT_TIME + EXIT_WINDOW_MINUTES) {
    return Response.json({ status: "Not exit window", exits: 0 });
  }

  const supabase = createServiceClient();
  const todayIst = istDateStr(now);

  const { data: strat } = await supabase
    .from("bot_strategies").select("id").eq("name", "overnight_hold").maybeSingle();
  if (!strat) return Response.json({ status: "overnight_hold strategy missing", exits: 0 });

  const { data: openTrades, error } = await supabase
    .from("bot_paper_trades")
    .select("id,instrument_id,entry_price,entry_time,shares,risk_amount,instruments(symbol)")
    .eq("strategy_id", strat.id)
    .eq("status", "open");
  if (error) return Response.json({ error: error.message, exits: 0 });

  let exits = 0;
  const closed: string[] = [];
  let totalNet = 0;
  for (const t of (openTrades ?? [])) {
    // Exit price = today's OPEN = first 1-min candle open of the IST day.
    const { data: candles } = await supabase
      .from("bot_candles")
      .select("open")
      .eq("instrument_id", t.instrument_id)
      .eq("timeframe", "1m")
      .gte("candle_open_at", `${todayIst}T03:45:00Z`)  // 9:15 IST
      .order("candle_open_at", { ascending: true })
      .limit(1);
    const openPx = candles && candles.length > 0 ? Number(candles[0].open) : null;
    if (!openPx || openPx <= 0) continue;

    const s = settleOvernight(Number(t.entry_price), openPx, t.shares);
    const rMultiple = t.risk_amount > 0 ? s.net_pnl / t.risk_amount : null;

    const { error: upErr } = await supabase
      .from("bot_paper_trades")
      .update({
        exit_price: Number(openPx.toFixed(4)),
        exit_time: now.toISOString(),
        exit_reason: "manual",   // schema constraint: overnight uses 'manual'
        status: "closed",
        gross_pnl: s.gross_pnl,
        brokerage: s.brokerage,
        statutory_charges: s.statutory_charges,
        net_pnl: s.net_pnl,
      })
      .eq("id", t.id);
    if (upErr) { console.error("[overnight-exit] update failed:", upErr.message); continue; }

    // Keep the promotion engine's outcome ledger in sync (best-effort).
    await supabase.from("bot_signal_outcomes").update({
      exit_price: Number(openPx.toFixed(4)), exit_reason: "manual",
      gross_pnl: s.gross_pnl, net_pnl: s.net_pnl, r_multiple: rMultiple,
      status: "closed", closed_at: now.toISOString(),
    }).eq("paper_trade_id", t.id);

    const inst = Array.isArray(t.instruments) ? t.instruments[0] : t.instruments as { symbol: string } | null;
    exits++; totalNet += s.net_pnl;
    closed.push(`${inst?.symbol ?? "?"} net ₹${s.net_pnl.toFixed(0)}`);
  }

  if (exits > 0) {
    await sendTelegramNotification({
      type: "heartbeat",
      symbol: "OVERNIGHT",
      timestamp: now.toISOString(),
      message: `🌅 Overnight exit — ${exits} closed, net ₹${totalNet.toFixed(0)}:\n${closed.join("\n")}`,
    });
  }

  return Response.json({ status: "overnight exit complete", exits, net_pnl: totalNet, closed });
});
