// Cross-sectional momentum — pure logic (no I/O, unit-tested in momentum.test.ts).
//
// Edge: hold the strongest N stocks by trailing return, rebalance monthly. The
// ONLY ₹50k-accessible edge that survived honest validation: survivorship-free
// full-universe PF 1.3-2.6 OOS, and it HELD in the 2023-25 AI-era regime
// (PF 4.8 large-cap / ~1.5 realistic). Swing hold => delivery charges barely bite.
//
// Reuses the tested delivery-charge model from overnight.ts (single source).
import { BROKERAGE_PER_LEG, deliveryStatutoryCharges } from "./overnight.ts";

/** Trailing simple return over `lookback` bars. null if not enough history. */
export function trailingReturn(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const now = closes[closes.length - 1];
  const past = closes[closes.length - 1 - lookback];
  if (!past || past <= 0 || !now || now <= 0) return null;
  return now / past - 1;
}

/** Top-N symbols by momentum (desc), ignoring non-finite scores. */
export function rankTopN(moms: Record<string, number>, n: number): string[] {
  return Object.entries(moms)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([s]) => s);
}

/** What to change: buy new winners, sell holdings that fell out of the top set. */
export function rebalanceDelta(
  current: string[],
  target: string[],
): { buy: string[]; sell: string[] } {
  const cur = new Set(current), tgt = new Set(target);
  return {
    buy: target.filter((s) => !cur.has(s)),
    sell: current.filter((s) => !tgt.has(s)),
  };
}

export function sizeShares(price: number, positionValue: number): number {
  return price > 0 ? Math.floor(positionValue / price) : 0;
}

export type Settlement = {
  gross_pnl: number; brokerage: number; statutory_charges: number; net_pnl: number;
};

/** Close a long at delivery charges (momentum is CNC, held weeks). */
export function settleDelivery(entry: number, exit: number, shares: number): Settlement {
  const bv = entry * shares, sv = exit * shares;
  const gross = sv - bv;
  const brokerage = BROKERAGE_PER_LEG * 2;
  const statutory = deliveryStatutoryCharges(bv, "BUY") + deliveryStatutoryCharges(sv, "SELL");
  return {
    gross_pnl: Number(gross.toFixed(4)),
    brokerage: Number(brokerage.toFixed(4)),
    statutory_charges: Number(statutory.toFixed(4)),
    net_pnl: Number((gross - brokerage - statutory).toFixed(4)),
  };
}
