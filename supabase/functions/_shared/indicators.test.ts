import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  sma, ema, rsi, macd, adx, stochasticFast, stochasticSlow,
  cci, parabolicSar, stochRsi, mfi, williamsR, ichimoku,
} from "./indicators.ts";

// SMA tests
Deno.test("sma: calculates simple moving average", () => {
  const values = [1, 2, 3, 4, 5];
  assertEquals(sma(values, 3), 4, "SMA of last 3 values: (3+4+5)/3 = 4");
});

Deno.test("sma: returns NaN for insufficient data", () => {
  const values = [1, 2];
  const result = sma(values, 5);
  assertEquals(Number.isNaN(result), true, "SMA needs at least period values");
});

// EMA tests
Deno.test("ema: calculates exponential moving average", () => {
  const values = [10, 11, 12, 13, 14, 15];
  const result = ema(values, 3);
  assertEquals(typeof result, "number");
  assertEquals(result > 0, true, "EMA should be positive");
  assertEquals(result <= 15, true, "EMA should not exceed max value");
});

Deno.test("ema: returns NaN for insufficient data", () => {
  const result = ema([1, 2], 5);
  assertEquals(Number.isNaN(result), true);
});

// RSI tests
Deno.test("rsi: calculates RSI in uptrend (>70)", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i); // Steady uptrend
  const result = rsi(closes, 14);
  assertEquals(result > 70, true, "Steady uptrend should have RSI > 70");
});

Deno.test("rsi: calculates RSI in downtrend (<30)", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i); // Steady downtrend
  const result = rsi(closes, 14);
  assertEquals(result < 30, true, "Steady downtrend should have RSI < 30");
});

// MACD tests
Deno.test("macd: detects bullish MACD crossover", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5); // Steady uptrend
  const result = macd(closes, 14, 5, 3);
  assertEquals(typeof result.line, "number");
  assertEquals(typeof result.signalLine, "number");
  assertEquals(typeof result.histogram, "number", "MACD should calculate histogram");
});

Deno.test("macd: returns NaN for invalid parameters", () => {
  const result = macd([1, 2, 3], 5, 14, 3); // slow < fast is invalid
  assertEquals(Number.isNaN(result.line), true);
});

// ADX tests
Deno.test("adx: calculates directional indicators", () => {
  const highs = Array.from({ length: 30 }, (_, i) => 100 + i);
  const lows = Array.from({ length: 30 }, (_, i) => 99 + i);
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const result = adx(highs, lows, closes, 14);
  assertEquals(typeof result.diPlus, "number");
  assertEquals(typeof result.diMinus, "number");
});

// Stochastic tests
Deno.test("stochastic fast: calculates %K and %D", () => {
  const highs = [100, 105, 110, 108, 112];
  const lows = [95, 100, 105, 103, 107];
  const closes = [98, 103, 108, 106, 110];
  const result = stochasticFast(highs, lows, closes, 3, 3);
  assertEquals(result.k >= 0 && result.k <= 100, true, "%K should be 0-100");
  assertEquals(result.d >= 0 && result.d <= 100, true, "%D should be 0-100");
});

// CCI tests
Deno.test("cci: calculates commodity channel index", () => {
  const highs = Array.from({ length: 20 }, (_, i) => 100 + i);
  const lows = Array.from({ length: 20 }, (_, i) => 99 + i);
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const result = cci(highs, lows, closes, 14);
  assertEquals(typeof result, "number");
  assertEquals(result > 0, true, "Steady uptrend should have positive CCI");
});

// Parabolic SAR tests
Deno.test("parabolic sar: calculates stop and reverse", () => {
  const highs = [100, 101, 102, 103, 104, 105];
  const lows = [99, 100, 101, 102, 103, 104];
  const closes = [100, 101, 102, 103, 104, 105];
  const result = parabolicSar(highs, lows, closes);
  assertEquals(typeof result, "number");
  assertEquals(result < closes[closes.length - 1], true, "SAR should be below price in uptrend");
});

// StochRSI tests
Deno.test("stoch rsi: calculates stochastic of RSI", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
  const result = stochRsi(closes, 14);
  assertEquals(result >= 0 && result <= 100, true, "StochRSI should be 0-100");
});

// MFI tests
Deno.test("mfi: calculates money flow index", () => {
  const highs = [100, 101, 102, 103, 104, 105];
  const lows = [99, 100, 101, 102, 103, 104];
  const closes = [100, 101, 102, 103, 104, 105];
  const volumes = [1000, 1100, 1200, 1300, 1400, 1500];
  const result = mfi(highs, lows, closes, volumes, 5);
  assertEquals(result > 50, true, "Uptrend with increasing volume should have MFI > 50");
});

// Williams %R tests
Deno.test("williams r: calculates williams percent range", () => {
  const highs = [100, 101, 102, 103, 104, 105];
  const lows = [99, 100, 101, 102, 103, 104];
  const closes = [105, 104, 103, 102, 101, 100];
  const result = williamsR(highs, lows, closes, 5);
  assertEquals(result >= -100 && result <= 0, true, "Williams %R should be -100 to 0");
  assertEquals(result < -80, true, "Downtrend should have Williams %R < -80");
});

// Ichimoku tests
Deno.test("ichimoku: calculates all cloud components", () => {
  const highs = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
  const lows = Array.from({ length: 30 }, (_, i) => 99 + i * 0.5);
  const result = ichimoku(highs, lows, 5, 14, 26);
  assertEquals(typeof result.conversion, "number");
  assertEquals(typeof result.base, "number");
  assertEquals(typeof result.spanA, "number");
  assertEquals(typeof result.spanB, "number");
  assertEquals(typeof result.cloudTop, "number");
});

Deno.test("ichimoku: cloudTop is max of spans", () => {
  const highs = Array.from({ length: 30 }, (_, i) => 100 + i);
  const lows = Array.from({ length: 30 }, (_, i) => 99 + i);
  const result = ichimoku(highs, lows, 5, 14, 26);
  assertEquals(result.cloudTop, Math.max(result.spanA, result.spanB));
});
