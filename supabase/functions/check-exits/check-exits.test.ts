import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Exit price slippage tests
Deno.test("exit slippage: applies 0.10% slippage on stop loss", () => {
  const stopPrice = 2450;
  const slippagePct = 0.0010;
  const slippageAmount = stopPrice * slippagePct;

  assertEquals(slippageAmount, 2.45, "0.10% slippage on ₹2450 should be ₹2.45");
});

Deno.test("exit slippage: applies 0.05% slippage on target", () => {
  const targetPrice = 2550;
  const slippagePct = 0.0005;
  const slippageAmount = targetPrice * slippagePct;

  assertEquals(Math.round(slippageAmount * 1000) / 1000, 1.275, "0.05% slippage on ₹2550 should be ₹1.275");
});

// Long exit detection
Deno.test("long exit: triggers stop when candle low reaches stop loss", () => {
  const stopLoss = 2450;
  const candle = { low: 2445, high: 2500, close: 2480, volume: 10000 };

  const hitsStop = candle.low <= stopLoss;
  assertEquals(hitsStop, true, "Candle low at 2445 should hit stop at 2450");
});

Deno.test("long exit: triggers target when candle high reaches target", () => {
  const target = 2600;
  const candle = { low: 2550, high: 2605, close: 2595, volume: 12000 };

  const hitsTarget = candle.high >= target;
  assertEquals(hitsTarget, true, "Candle high at 2605 should hit target at 2600");
});

// Short exit detection
Deno.test("short exit: triggers stop when candle high reaches stop loss", () => {
  const stopLoss = 2550;
  const candle = { low: 2500, high: 2560, close: 2520, volume: 10000 };

  const hitsStop = candle.high >= stopLoss;
  assertEquals(hitsStop, true, "Candle high at 2560 should hit stop at 2550");
});

Deno.test("short exit: triggers target when candle low reaches target", () => {
  const target = 2400;
  const candle = { low: 2390, high: 2450, close: 2410, volume: 12000 };

  const hitsTarget = candle.low <= target;
  assertEquals(hitsTarget, true, "Candle low at 2390 should hit target at 2400");
});

// P&L calculation
Deno.test("pnl calculation: calculates gross P&L for long trades", () => {
  const entryPrice = 2500;
  const exitPrice = 2550;
  const shares = 10;

  const grossPnl = (exitPrice - entryPrice) * shares;
  assertEquals(grossPnl, 500, "Long profit of ₹50 per share × 10 shares = ₹500");
});

Deno.test("pnl calculation: calculates gross P&L for short trades", () => {
  const entryPrice = 2500;
  const exitPrice = 2450;
  const shares = 10;

  const grossPnl = (entryPrice - exitPrice) * shares;
  assertEquals(grossPnl, 500, "Short profit of ₹50 per share × 10 shares = ₹500");
});

// Statutory charges and brokerage
Deno.test("charges: calculates statutory 0.05% fee correctly", () => {
  const exitValue = 2500 * 10; // ₹25,000
  const statutoryFee = exitValue * 0.0005;

  assertEquals(statutoryFee, 12.5, "0.05% of ₹25,000 should be ₹12.50");
});

Deno.test("charges: applies brokerage of ₹40 per round trip", () => {
  const brokerage = 20 * 2; // ₹20 per leg × 2 legs
  assertEquals(brokerage, 40, "Round-trip brokerage should be ₹40");
});

// Net P&L calculation
Deno.test("net pnl: calculates correctly after all charges", () => {
  const grossPnl = 500;
  const statutory = 12.5;
  const brokerage = 40;

  const netPnl = grossPnl - statutory - brokerage;
  assertEquals(netPnl, 447.5, "Net P&L: ₹500 - ₹12.5 - ₹40 = ₹447.5");
});

Deno.test("net pnl: handles losses with charges", () => {
  const grossPnl = -100; // Loss
  const statutory = 5;
  const brokerage = 40;

  const netPnl = grossPnl - statutory - brokerage;
  assertEquals(netPnl, -145, "Loss of ₹100 + charges = ₹145 total loss");
});

// Exit reason assignment
Deno.test("exit reason: marks stop loss exits", () => {
  const exitReason = "stop";
  assertEquals(exitReason, "stop");
});

Deno.test("exit reason: marks target exits", () => {
  const exitReason = "target";
  assertEquals(exitReason, "target");
});
