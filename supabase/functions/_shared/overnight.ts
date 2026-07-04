// Overnight-hold strategy — pure logic (no I/O, unit-tested in overnight.test.ts).
//
// STATUS (2026-07-04): DISABLED after real-delivery-charge validation.
// The gross overnight premium is real (+~0.14%/night, pooled PF 1.24 at
// intraday-style charges) but overnight = CNC DELIVERY, and delivery charges
// (~0.29%/round-trip: STT 0.1% BOTH legs + stamp + DP) exceed the gross edge.
// Re-tested with the delivery model below: pooled PF 0.602, 0/22 symbols
// profitable. Strategy is parked in `research`, crons unscheduled. Do not
// re-enable for cash equity; a futures variant (STT 0.02% sell-only) is the
// only plausible revival and needs its own backtest.
//
// Charges here are REAL EQUITY DELIVERY (CNC) — deliberately heavier than the
// intraday model in trade-math, so paper results can never overstate reality.

export const BROKERAGE_PER_LEG = 20.0; // Angel One delivery ₹20/leg
export const DELIVERY_STT_PCT = 0.001; // 0.1% of traded value, BOTH legs (the killer)
export const EXCHANGE_TXN_PCT = 0.0000297; // NSE 0.00297%
export const SEBI_FEE_PCT = 0.000001; // ₹10/crore
export const STAMP_DUTY_BUY_PCT = 0.00015; // 0.015% buy side (delivery)
export const DP_CHARGE_PER_SELL = 18.5; // depository debit per sell
export const GST_RATE = 0.18; // on brokerage + exchange + sebi

// Overnight positions have no intraday stop, but the schema requires positive
// stop/target. Use wide sentinels that no intraday path will ever hit.
export const OVERNIGHT_STOP_PCT = 0.5; // 50% below entry — never triggers
export const OVERNIGHT_TARGET_PCT = 0.5; // 50% above entry — never triggers

/** Size an overnight long. Risk is framed as a ~1% adverse gap = risk_amount. */
export function sizeOvernight(
  entryPrice: number,
  riskAmount: number,
  assumedGapPct = 0.01,
): number {
  if (entryPrice <= 0 || riskAmount <= 0 || assumedGapPct <= 0) return 0;
  return Math.floor(riskAmount / (entryPrice * assumedGapPct));
}

export type OvernightEntry = {
  side: "long";
  entry_price: number;
  entry_slippage_pct: number;
  stop_loss_price: number;
  target_price: number;
  shares: number;
  risk_amount: number;
};

/** Build the bot_paper_trades insert payload for an overnight long. */
export function buildOvernightEntry(
  entryPrice: number,
  riskAmount: number,
): OvernightEntry | null {
  const shares = sizeOvernight(entryPrice, riskAmount);
  if (shares <= 0) return null;
  return {
    side: "long",
    entry_price: Number(entryPrice.toFixed(4)),
    entry_slippage_pct: 0, // buy the actual close; no modelled entry slippage
    stop_loss_price: Number((entryPrice * (1 - OVERNIGHT_STOP_PCT)).toFixed(4)),
    target_price: Number((entryPrice * (1 + OVERNIGHT_TARGET_PCT)).toFixed(4)),
    shares,
    risk_amount: riskAmount,
  };
}

export type OvernightSettlement = {
  gross_pnl: number;
  brokerage: number;
  statutory_charges: number;
  net_pnl: number;
};

/** One leg of real equity-DELIVERY charges (excl. brokerage, reported separately). */
export function deliveryStatutoryCharges(value: number, side: "BUY" | "SELL"): number {
  const stt = value * DELIVERY_STT_PCT; // both legs on delivery
  const exch = value * EXCHANGE_TXN_PCT;
  const sebi = value * SEBI_FEE_PCT;
  const stamp = side === "BUY" ? value * STAMP_DUTY_BUY_PCT : 0;
  const dp = side === "SELL" ? DP_CHARGE_PER_SELL : 0;
  const gst = GST_RATE * (BROKERAGE_PER_LEG + exch + sebi);
  return stt + exch + sebi + stamp + dp + gst;
}

/** Settle an overnight long at the next open, at REAL delivery charges. */
export function settleOvernight(
  entryPrice: number,
  exitOpenPrice: number,
  shares: number,
): OvernightSettlement {
  const entryValue = entryPrice * shares;
  const exitValue = exitOpenPrice * shares;
  const gross = exitValue - entryValue;
  const brokerage = BROKERAGE_PER_LEG * 2; // entry + exit leg
  const statutory = deliveryStatutoryCharges(entryValue, "BUY") +
    deliveryStatutoryCharges(exitValue, "SELL");
  const net = gross - brokerage - statutory;
  return {
    gross_pnl: Number(gross.toFixed(4)),
    brokerage: Number(brokerage.toFixed(4)),
    statutory_charges: Number(statutory.toFixed(4)),
    net_pnl: Number(net.toFixed(4)),
  };
}
