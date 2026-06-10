// Pure decision math for the cost-aware selective trading engine.
// Spec: docs/superpowers/specs/2026-06-10-cost-aware-selective-engine-design.md
// No I/O here — edge functions wire data in and out, which keeps every rule
// unit-testable (see trade-math.test.ts).

export type Candle1m = { high: number; low: number; close: number };
export type TradeSide = "long" | "short";

const ATR_PERIOD = 14;
const STOP_ATR_MULT = 1.0;
const STOP_MIN_PCT = 0.004;   // 0.4% of price
const STOP_MAX_PCT = 0.015;   // 1.5% of price
const STOP_FALLBACK_PCT = 0.0075;
const TARGET_R_MULTIPLE = 1.5;

const BROKERAGE_ROUND_TRIP = 40;     // ₹20 per leg
const STATUTORY_FEE_PCT = 0.0005;    // 0.05% on exit value
const MAX_CHARGES_PCT_OF_WIN = 0.10;

const BREAKEVEN_TRIGGER_R = 1.0;
const TIME_STOP_MINUTES = 60;
const TIME_STOP_MIN_R = 0.5;

// ---------------------------------------------------------------------------
// ATR over 5-min bars aggregated from 1-min candles (input oldest → newest).
// Returns null when fewer than ATR_PERIOD+1 complete five-min bars exist.
// ---------------------------------------------------------------------------

export function atrFrom1mCandles(candles: Candle1m[]): number | null {
  const barCount = Math.floor(candles.length / 5);
  if (barCount < ATR_PERIOD + 1) return null;

  // Aggregate the most recent barCount*5 candles into 5-min bars.
  const usable = candles.slice(candles.length - barCount * 5);
  const bars: Candle1m[] = [];
  for (let i = 0; i < barCount; i++) {
    const chunk = usable.slice(i * 5, i * 5 + 5);
    bars.push({
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }

  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  }

  const window = trs.slice(-ATR_PERIOD);
  return window.reduce((s, v) => s + v, 0) / window.length;
}

// ---------------------------------------------------------------------------
// Stop = 1×ATR clamped to [0.4%, 1.5%] of entry; target = 1.5× stop distance.
// Null ATR (thin data) falls back to a 0.75% stop.
// ---------------------------------------------------------------------------

export function stopTargetFromAtr(
  side: TradeSide,
  entryPrice: number,
  atr: number | null,
): { stopLossPrice: number; targetPrice: number } {
  const rawDist = atr === null ? entryPrice * STOP_FALLBACK_PCT : atr * STOP_ATR_MULT;
  const stopDist = Math.min(
    Math.max(rawDist, entryPrice * STOP_MIN_PCT),
    entryPrice * STOP_MAX_PCT,
  );
  const targetDist = stopDist * TARGET_R_MULTIPLE;

  if (side === "long") {
    return {
      stopLossPrice: Number((entryPrice - stopDist).toFixed(4)),
      targetPrice: Number((entryPrice + targetDist).toFixed(4)),
    };
  }
  return {
    stopLossPrice: Number((entryPrice + stopDist).toFixed(4)),
    targetPrice: Number((entryPrice - targetDist).toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// Signal quality score, 0–100. Components per spec §1:
//   volume surge (0–40), OR-range sanity (0–20, 10 when unknown),
//   relative strength vs NIFTY (0–25, 12 when unknown), time of day (0–15).
// ---------------------------------------------------------------------------

export function scoreSignal(input: {
  volumeMultiplier: number;
  orRangePct: number | null;
  stockMovePct: number;
  niftyMovePct: number | null;
  side: TradeSide;
  minutesSinceOpenIst: number;
}): { score: number; components: Record<string, number> } {
  const volume = Math.min(40, Math.max(0, Math.round(input.volumeMultiplier * 13.3)));

  let orRange: number;
  if (input.orRangePct === null) {
    orRange = 10;
  } else {
    orRange = input.orRangePct >= 0.003 && input.orRangePct <= 0.05 ? 20 : 0;
  }

  let relativeStrength: number;
  if (input.niftyMovePct === null) {
    relativeStrength = 12;
  } else {
    const alignedDiffPct = input.side === "long"
      ? (input.stockMovePct - input.niftyMovePct) * 100
      : (input.niftyMovePct - input.stockMovePct) * 100;
    relativeStrength = Math.min(25, Math.max(0, Math.round(alignedDiffPct * 12.5)));
  }

  let timeOfDay: number;
  if (input.minutesSinceOpenIst <= 105) {
    timeOfDay = 15;
  } else if (input.minutesSinceOpenIst >= 225) {
    timeOfDay = 0;
  } else {
    timeOfDay = Math.round(15 * (225 - input.minutesSinceOpenIst) / 120);
  }

  const components = { volume, orRange, relativeStrength, timeOfDay };
  const score = Math.min(100, volume + orRange + relativeStrength + timeOfDay);
  return { score, components };
}

// ---------------------------------------------------------------------------
// Trade economics gate, spec §2. Rejects trades whose expected value is
// negative at the strategy's live win rate, or where fixed charges eat more
// than 10% of the expected win.
// ---------------------------------------------------------------------------

export function economicsGate(input: {
  side: TradeSide;
  entryPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  shares: number;
  winRate: number;
}): { accept: boolean; reason?: string } {
  const stopDist = Math.abs(input.entryPrice - input.stopLossPrice);
  const targetDist = Math.abs(input.targetPrice - input.entryPrice);
  const expectedWin = targetDist * input.shares;
  const expectedLoss = stopDist * input.shares;
  const exitValue = input.targetPrice * input.shares;
  const charges = BROKERAGE_ROUND_TRIP + STATUTORY_FEE_PCT * exitValue;

  if (charges > MAX_CHARGES_PCT_OF_WIN * expectedWin) {
    return {
      accept: false,
      reason: `economics: charges ₹${charges.toFixed(0)} exceed 10% of expected win ₹${expectedWin.toFixed(0)}`,
    };
  }

  const ev = input.winRate * expectedWin - (1 - input.winRate) * expectedLoss - charges;
  if (ev <= 0) {
    return {
      accept: false,
      reason: `economics: negative EV ₹${ev.toFixed(0)} at ${(input.winRate * 100).toFixed(0)}% win rate`,
    };
  }

  return { accept: true };
}

// ---------------------------------------------------------------------------
// NIFTY regime filter, spec §4. Longs only above the index opening range,
// shorts only below it. Abstains (allows) when index data is missing/stale.
// ---------------------------------------------------------------------------

export function niftyRegimeAllows(
  side: TradeSide,
  niftySpot: number | null,
  orHigh: number | null,
  orLow: number | null,
): boolean {
  if (niftySpot === null || orHigh === null || orLow === null) return true;
  return side === "long" ? niftySpot > orHigh : niftySpot < orLow;
}

// ---------------------------------------------------------------------------
// Exit rules, spec §3.
// ---------------------------------------------------------------------------

export function shouldMoveToBreakeven(
  unrealizedGross: number,
  riskAmount: number,
  alreadyMoved: boolean,
): boolean {
  if (alreadyMoved || riskAmount <= 0) return false;
  return unrealizedGross >= BREAKEVEN_TRIGGER_R * riskAmount;
}

export function shouldTimeStop(
  ageMinutes: number,
  unrealizedGross: number,
  riskAmount: number,
): boolean {
  if (riskAmount <= 0) return false;
  if (ageMinutes <= TIME_STOP_MINUTES) return false;
  return unrealizedGross < TIME_STOP_MIN_R * riskAmount;
}
