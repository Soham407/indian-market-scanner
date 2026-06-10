import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  atrFrom1mCandles,
  economicsGate,
  niftyRegimeAllows,
  scoreSignal,
  shouldMoveToBreakeven,
  shouldTimeStop,
  stopTargetFromAtr,
  type Candle1m,
} from "./trade-math.ts";

// ---------------------------------------------------------------------------
// atrFrom1mCandles
// ---------------------------------------------------------------------------

function flatCandles(n: number, price: number, range: number): Candle1m[] {
  return Array.from({ length: n }, () => ({
    high: price + range / 2,
    low: price - range / 2,
    close: price,
  }));
}

Deno.test("atrFrom1mCandles returns null with too few candles", () => {
  assertEquals(atrFrom1mCandles(flatCandles(70, 100, 1)), null);
});

Deno.test("atrFrom1mCandles computes ATR over 5-min aggregated bars", () => {
  // 80 one-min candles -> 16 five-min bars -> 15 TRs, ATR of last 14.
  // Every bar has high=100.5, low=99.5, close=100 -> TR = 1 for every bar.
  const atr = atrFrom1mCandles(flatCandles(80, 100, 1));
  assertEquals(atr !== null && Math.abs(atr - 1) < 1e-9, true);
});

// ---------------------------------------------------------------------------
// stopTargetFromAtr
// ---------------------------------------------------------------------------

Deno.test("stopTargetFromAtr clamps tiny ATR to 0.4% stop and sets 1.5R target", () => {
  const { stopLossPrice, targetPrice } = stopTargetFromAtr("long", 1000, 0.5);
  assertEquals(stopLossPrice, 996); // 0.4% of 1000 = 4
  assertEquals(targetPrice, 1006);  // 1.5 × 4 = 6
});

Deno.test("stopTargetFromAtr clamps huge ATR to 1.5% stop", () => {
  const { stopLossPrice, targetPrice } = stopTargetFromAtr("long", 1000, 100);
  assertEquals(stopLossPrice, 985);   // 1.5% of 1000 = 15
  assertEquals(targetPrice, 1022.5);  // 1.5 × 15 = 22.5
});

Deno.test("stopTargetFromAtr uses raw ATR when inside clamp band", () => {
  const { stopLossPrice, targetPrice } = stopTargetFromAtr("long", 1000, 8);
  assertEquals(stopLossPrice, 992);
  assertEquals(targetPrice, 1012);
});

Deno.test("stopTargetFromAtr direction for shorts", () => {
  const { stopLossPrice, targetPrice } = stopTargetFromAtr("short", 1000, 8);
  assertEquals(stopLossPrice, 1008);
  assertEquals(targetPrice, 988);
});

Deno.test("stopTargetFromAtr null ATR falls back to 0.75% stop", () => {
  const { stopLossPrice, targetPrice } = stopTargetFromAtr("long", 1000, null);
  assertEquals(stopLossPrice, 992.5);
  assertEquals(targetPrice, 1011.25);
});

// ---------------------------------------------------------------------------
// scoreSignal
// ---------------------------------------------------------------------------

const baseScoreInput = {
  volumeMultiplier: 3.0,      // -> 40 (capped)
  orRangePct: 0.01,           // in [0.003, 0.05] -> 20
  stockMovePct: 0.02,
  niftyMovePct: 0.0,          // long: (0.02-0)*100*12.5 = 25 (capped)
  side: "long" as const,
  minutesSinceOpenIst: 60,    // before 105 -> 15
};

Deno.test("scoreSignal caps at 100 with all components maxed", () => {
  const { score } = scoreSignal(baseScoreInput);
  assertEquals(score, 100);
});

Deno.test("scoreSignal time decay: zero time component at 225+ minutes", () => {
  const { components } = scoreSignal({ ...baseScoreInput, minutesSinceOpenIst: 225 });
  assertEquals(components.timeOfDay, 0);
});

Deno.test("scoreSignal time decay: linear between 105 and 225 minutes", () => {
  const { components } = scoreSignal({ ...baseScoreInput, minutesSinceOpenIst: 165 });
  assertEquals(components.timeOfDay, 8); // halfway -> round(7.5) = 8
});

Deno.test("scoreSignal null nifty move gives neutral 12 relative strength", () => {
  const { components } = scoreSignal({ ...baseScoreInput, niftyMovePct: null });
  assertEquals(components.relativeStrength, 12);
});

Deno.test("scoreSignal null OR range gives neutral 10", () => {
  const { components } = scoreSignal({ ...baseScoreInput, orRangePct: null });
  assertEquals(components.orRange, 10);
});

Deno.test("scoreSignal floors at 0 for weak everything", () => {
  const { score } = scoreSignal({
    volumeMultiplier: 0,
    orRangePct: 0.10,          // outside band -> 0
    stockMovePct: -0.02,       // long underperforming nifty -> 0
    niftyMovePct: 0.01,
    side: "long",
    minutesSinceOpenIst: 300,
  });
  assertEquals(score, 0);
});

Deno.test("scoreSignal short side aligns relative strength inversely", () => {
  // short: (nifty - stock)*100*12.5 = (0.01 - (-0.01))*100*12.5 = 25
  const { components } = scoreSignal({
    ...baseScoreInput,
    side: "short",
    stockMovePct: -0.01,
    niftyMovePct: 0.01,
  });
  assertEquals(components.relativeStrength, 25);
});

// ---------------------------------------------------------------------------
// economicsGate
// ---------------------------------------------------------------------------

Deno.test("economicsGate accepts profitable geometry", () => {
  // 100 shares, stop dist 10, target dist 15, p=0.45:
  // EV = 0.45*1500 - 0.55*1000 - (40 + 0.0005*101500) ≈ 675 - 550 - 90.75 = +34.25
  const result = economicsGate({
    side: "long",
    entryPrice: 1000,
    stopLossPrice: 990,
    targetPrice: 1015,
    shares: 100,
    winRate: 0.45,
  });
  assertEquals(result.accept, true);
});

Deno.test("economicsGate rejects when charges exceed 10% of expected win", () => {
  // 10 shares, target dist 15 -> expected win 150; charges ≈ 40+5 = 45 > 15
  const result = economicsGate({
    side: "long",
    entryPrice: 1000,
    stopLossPrice: 990,
    targetPrice: 1015,
    shares: 10,
    winRate: 0.45,
  });
  assertEquals(result.accept, false);
  assertEquals(result.reason?.startsWith("economics:"), true);
});

Deno.test("economicsGate rejects negative EV at low win rate", () => {
  // p=0.25: EV = 0.25*1500 - 0.75*1000 - charges < 0
  const result = economicsGate({
    side: "long",
    entryPrice: 1000,
    stopLossPrice: 990,
    targetPrice: 1015,
    shares: 100,
    winRate: 0.25,
  });
  assertEquals(result.accept, false);
  assertEquals(result.reason?.startsWith("economics:"), true);
});

// ---------------------------------------------------------------------------
// niftyRegimeAllows
// ---------------------------------------------------------------------------

Deno.test("niftyRegimeAllows long only above OR high", () => {
  assertEquals(niftyRegimeAllows("long", 25100, 25050, 24950), true);
  assertEquals(niftyRegimeAllows("long", 25000, 25050, 24950), false); // inside
  assertEquals(niftyRegimeAllows("long", 24900, 25050, 24950), false); // below
});

Deno.test("niftyRegimeAllows short only below OR low", () => {
  assertEquals(niftyRegimeAllows("short", 24900, 25050, 24950), true);
  assertEquals(niftyRegimeAllows("short", 25000, 25050, 24950), false);
  assertEquals(niftyRegimeAllows("short", 25100, 25050, 24950), false);
});

Deno.test("niftyRegimeAllows abstains (allows) when data missing", () => {
  assertEquals(niftyRegimeAllows("long", null, 25050, 24950), true);
  assertEquals(niftyRegimeAllows("long", 25100, null, 24950), true);
  assertEquals(niftyRegimeAllows("short", 25100, 25050, null), true);
});

// ---------------------------------------------------------------------------
// breakeven / time-stop
// ---------------------------------------------------------------------------

Deno.test("shouldMoveToBreakeven triggers at exactly +1R, once", () => {
  assertEquals(shouldMoveToBreakeven(1000, 1000, false), true);
  assertEquals(shouldMoveToBreakeven(999, 1000, false), false);
  assertEquals(shouldMoveToBreakeven(2000, 1000, true), false); // already moved
  assertEquals(shouldMoveToBreakeven(1000, 0, false), false);   // bad risk amount
});

Deno.test("shouldTimeStop fires after 60 min below +0.5R", () => {
  assertEquals(shouldTimeStop(61, 100, 1000), true);   // 0.1R after 61 min
  assertEquals(shouldTimeStop(61, 600, 1000), false);  // 0.6R — momentum alive
  assertEquals(shouldTimeStop(60, 100, 1000), false);  // not past 60 min yet
  assertEquals(shouldTimeStop(61, 500, 1000), false);  // exactly +0.5R survives
  assertEquals(shouldTimeStop(61, -400, 1000), true);  // losing trade past 60 min
});
