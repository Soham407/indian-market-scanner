// momentum-rebalance — monthly cross-sectional momentum, PAPER.
//
// Holds the top-N NSE names by 126-day return, rebalances monthly. The validated
// ₹50k-accessible edge (survivorship-free OOS + current-regime confirmed).
// Paper only: builds a forward track record. Real money never touched.
//
// Prices come from Yahoo daily (self-contained; the bot's 1m candles don't retain
// the 6-month lookback momentum needs). Per-ticker failures are skipped, not fatal.
import { createServiceClient } from "../_shared/supabase.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import { rankTopN, rebalanceDelta, settleDelivery, sizeShares, trailingReturn } from "../_shared/momentum.ts";

const LOOKBACK = 126;   // ~6 trading months
const HOLD_TOP = 5;     // ₹50k / 5 = ₹10k per name
const WIDE = 0.5;       // sentinel stop/target (schema needs >0; never used — no intraday stop)

// Liquid NSE universe (intersected with the instruments table at runtime).
const UNIVERSE = [
  "RELIANCE","TCS","INFY","HDFCBANK","ICICIBANK","SBIN","ITC","LT","AXISBANK","KOTAKBANK",
  "BHARTIARTL","HINDUNILVR","MARUTI","TATASTEEL","SUNPHARMA","BAJFINANCE","TITAN","ADANIPORTS",
  "JSWSTEEL","TECHM","HCLTECH","POWERGRID","NTPC","ONGC","COALINDIA","BEL","HAL","TRENT",
];

async function yahooDailyCloses(symbol: string): Promise<number[] | null> {
  const now = Math.floor(Date.now() / 1000);
  const p1 = now - 300 * 24 * 3600; // ~300 calendar days back for 126 trading-day lookback
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?period1=${p1}&period2=${now}&interval=1d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const closes = res?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) return null;
    return closes.filter((c: number | null) => typeof c === "number" && c > 0) as number[];
  } catch {
    return null;
  }
}

Deno.serve(async () => {
  const supabase = createServiceClient();

  const { data: strat } = await supabase
    .from("bot_strategies").select("id,enabled").eq("name", "momentum_swing").maybeSingle();
  if (!strat || strat.enabled === false) {
    return Response.json({ status: "momentum_swing disabled/missing", rebalanced: 0 });
  }
  const { data: settings } = await supabase
    .from("bot_settings").select("paper_capital").limit(1).maybeSingle();
  const capital = Number(settings?.paper_capital ?? 50000);
  const positionValue = capital / HOLD_TOP;

  const { data: instruments } = await supabase
    .from("instruments").select("id,symbol").eq("exchange", "NSE").in("symbol", UNIVERSE);
  if (!instruments || instruments.length < HOLD_TOP) {
    return Response.json({ status: "too few instruments", rebalanced: 0 });
  }
  const idBySymbol = new Map(instruments.map((i) => [i.symbol, i.id]));

  // Momentum + latest close per symbol (skip fetch failures).
  const moms: Record<string, number> = {};
  const lastClose: Record<string, number> = {};
  for (const inst of instruments) {
    const closes = await yahooDailyCloses(inst.symbol);
    if (!closes || closes.length <= LOOKBACK) continue;
    const m = trailingReturn(closes, LOOKBACK);
    if (m === null) continue;
    moms[inst.symbol] = m;
    lastClose[inst.symbol] = closes[closes.length - 1];
  }
  if (Object.keys(moms).length < HOLD_TOP) {
    return Response.json({ status: "insufficient price data", scored: Object.keys(moms).length });
  }

  const target = rankTopN(moms, HOLD_TOP);

  // Current open momentum holdings (symbol via instrument join).
  const { data: openRows } = await supabase
    .from("bot_paper_trades")
    .select("id,instrument_id,entry_price,shares,risk_amount,instruments(symbol)")
    .eq("strategy_id", strat.id).eq("status", "open");
  type OpenRow = { id: string; instrument_id: string; entry_price: number; shares: number; risk_amount: number; instruments: unknown };
  const openBySymbol = new Map<string, OpenRow>();
  for (const r of ((openRows ?? []) as OpenRow[])) {
    const sym = (Array.isArray(r.instruments) ? r.instruments[0] : r.instruments)?.symbol;
    if (sym) openBySymbol.set(sym, r);
  }

  const { buy, sell } = rebalanceDelta([...openBySymbol.keys()], target);

  const log: string[] = [];
  let netClosed = 0;
  // SELL dropouts at latest close.
  for (const sym of sell) {
    const row = openBySymbol.get(sym)!;
    const px = lastClose[sym];
    if (!px) continue;
    const s = settleDelivery(Number(row.entry_price), px, row.shares);
    await supabase.from("bot_paper_trades").update({
      exit_price: Number(px.toFixed(4)), exit_time: new Date().toISOString(),
      exit_reason: "manual", status: "closed",
      gross_pnl: s.gross_pnl, brokerage: s.brokerage,
      statutory_charges: s.statutory_charges, net_pnl: s.net_pnl,
    }).eq("id", row.id);
    netClosed += s.net_pnl;
    log.push(`SELL ${sym} net ₹${s.net_pnl.toFixed(0)}`);
  }
  // BUY new winners at latest close.
  for (const sym of buy) {
    const px = lastClose[sym];
    const id = idBySymbol.get(sym);
    if (!px || !id) continue;
    const shares = sizeShares(px, positionValue);
    if (shares <= 0) continue;
    await supabase.from("bot_paper_trades").insert({
      strategy_id: strat.id, instrument_id: id, side: "long",
      entry_price: Number(px.toFixed(4)), entry_time: new Date().toISOString(),
      entry_slippage_pct: 0,
      stop_loss_price: Number((px * (1 - WIDE)).toFixed(4)),
      target_price: Number((px * (1 + WIDE)).toFixed(4)),
      shares, risk_amount: positionValue, status: "open",
    });
    log.push(`BUY ${sym} ${shares}@${px.toFixed(1)}`);
  }

  if (buy.length || sell.length) {
    await sendTelegramNotification({
      type: "heartbeat", symbol: "MOMENTUM", timestamp: new Date().toISOString(),
      message: `📈 Momentum rebalance (paper ₹${capital.toLocaleString("en-IN")})\n` +
        `hold: ${target.join(", ")}\nclosed net ₹${netClosed.toFixed(0)}\n${log.join("\n")}`,
    });
  }

  return Response.json({
    status: "rebalanced", target, bought: buy, sold: sell, net_closed: netClosed,
  });
});
