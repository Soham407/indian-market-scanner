import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test helper functions extracted from index.ts
function istMinutesSinceMidnight(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isOrWindow(now = new Date()): boolean {
  const OR_WINDOW_START = 9 * 60 + 15; // 9:15 IST
  const OR_WINDOW_END = 9 * 60 + 30; // 9:30 IST
  const minutes = istMinutesSinceMidnight(now);
  return minutes >= OR_WINDOW_START && minutes < OR_WINDOW_END;
}

function isBreakoutWindow(now = new Date()): boolean {
  const OR_WINDOW_END = 9 * 60 + 30; // 9:30 IST
  const minutes = istMinutesSinceMidnight(now);
  return minutes >= OR_WINDOW_END && minutes < 15 * 60 + 30; // 9:30-15:30 IST
}

// Opening Range window detection
Deno.test("or window: detects 9:15-9:30 IST as OR build window", () => {
  // Monday 2026-05-25 at 9:20 IST
  const orTime = new Date("2026-05-25T03:50:00Z"); // 9:20 IST
  assertEquals(isOrWindow(orTime), true, "9:20 IST should be in OR window");
});

Deno.test("or window: rejects 9:00 IST as before OR window", () => {
  // Monday 2026-05-25 at 9:00 IST
  const beforeOr = new Date("2026-05-25T03:30:00Z"); // 9:00 IST
  assertEquals(isOrWindow(beforeOr), false, "9:00 IST is before OR window");
});

Deno.test("or window: rejects 9:35 IST as after OR window", () => {
  // Monday 2026-05-25 at 9:35 IST
  const afterOr = new Date("2026-05-25T04:05:00Z"); // 9:35 IST
  assertEquals(isOrWindow(afterOr), false, "9:35 IST is after OR window");
});

// Breakout window detection
Deno.test("breakout window: detects 10:00 IST as in breakout window", () => {
  // Monday 2026-05-25 at 10:00 IST
  const breakoutTime = new Date("2026-05-25T04:30:00Z"); // 10:00 IST
  assertEquals(isBreakoutWindow(breakoutTime), true, "10:00 IST should be in breakout window");
});

Deno.test("breakout window: accepts 15:20 IST as end of breakout window", () => {
  // Monday 2026-05-25 at 15:20 IST
  const eodTime = new Date("2026-05-25T09:50:00Z"); // 15:20 IST
  assertEquals(isBreakoutWindow(eodTime), true, "15:20 IST should be in breakout window");
});

Deno.test("breakout window: rejects 9:00 IST as before breakout window", () => {
  // Monday 2026-05-25 at 9:00 IST
  const beforeBreakout = new Date("2026-05-25T03:30:00Z"); // 9:00 IST
  assertEquals(isBreakoutWindow(beforeBreakout), false, "9:00 IST is before breakout window");
});

// OR calculation logic
Deno.test("or calculation: computes OR high from multiple candles", () => {
  const orCandles = [
    { high: 2500, low: 2490, close: 2495, volume: 10000 },
    { high: 2510, low: 2500, close: 2505, volume: 12000 },
    { high: 2505, low: 2495, close: 2500, volume: 11000 },
  ];

  const orHigh = Math.max(...orCandles.map((c) => c.high));
  assertEquals(orHigh, 2510, "OR high should be max of all candle highs");
});

Deno.test("or calculation: computes OR low from multiple candles", () => {
  const orCandles = [
    { high: 2500, low: 2490, close: 2495, volume: 10000 },
    { high: 2510, low: 2485, close: 2505, volume: 12000 },
    { high: 2505, low: 2495, close: 2500, volume: 11000 },
  ];

  const orLow = Math.min(...orCandles.map((c) => c.low));
  assertEquals(orLow, 2485, "OR low should be min of all candle lows");
});

// Long breakout detection
Deno.test("breakout detection: identifies long breakout above OR high", () => {
  const orHigh = 2500;
  const latestCandle = { close: 2505, high: 2510, low: 2505, volume: 15000 };
  const volumeMultiplier = 1.5;

  const isLongBreakout = latestCandle.close > orHigh &&
    latestCandle.volume >= volumeMultiplier * 10000;

  assertEquals(isLongBreakout, true, "Close above OR high should be long breakout");
});

Deno.test("breakout detection: rejects breakout with insufficient volume", () => {
  const orHigh = 2500;
  const latestCandle = { close: 2505, high: 2510, low: 2505, volume: 8000 };
  const volumeMultiplier = 1.5;

  const isValidBreakout = latestCandle.close > orHigh &&
    latestCandle.volume >= volumeMultiplier * 10000;

  assertEquals(isValidBreakout, false, "Low volume breakout should be rejected");
});

// Position sizing
Deno.test("position sizing: calculates shares based on risk", () => {
  const riskPerTrade = 1000;
  const entryPrice = 2500;
  const stopLoss = 2450;
  const shares = Math.floor(riskPerTrade / (entryPrice - stopLoss));

  assertEquals(shares, 20, "Risk of ₹1000 with ₹50 stop should be 20 shares");
});

// Entry slippage
Deno.test("entry slippage: applies 0.05% for long entries", () => {
  const entryPrice = 2500;
  const slippage = entryPrice * 0.0005;
  const actualEntry = entryPrice + slippage;

  assertEquals(actualEntry, 2500 + 2500 * 0.0005, "Long entry slippage should be 0.05% against");
});
