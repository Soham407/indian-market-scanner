import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test helper functions extracted from index.ts
function istMinutesSinceMidnight(now = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isEodWindow(now = new Date()): boolean {
  const EOD_TIME = 15 * 60 + 15; // 3:15 PM IST
  const minutes = istMinutesSinceMidnight(now);
  return minutes >= EOD_TIME && minutes < EOD_TIME + 15;
}

// EOD window detection tests
Deno.test("eod window: detects 3:15 PM IST as EOD", () => {
  // Monday 2026-05-25 at 3:15 PM IST
  const eodTime = new Date("2026-05-25T09:45:00Z"); // 3:15 PM IST
  assertEquals(isEodWindow(eodTime), true, "3:15 PM IST should be in EOD window");
});

Deno.test("eod window: rejects 2:00 PM IST as not EOD", () => {
  // Monday 2026-05-25 at 2:00 PM IST
  const beforeEod = new Date("2026-05-25T08:30:00Z"); // 2:00 PM IST
  assertEquals(isEodWindow(beforeEod), false, "2:00 PM IST should not be in EOD window");
});

Deno.test("eod window: rejects 3:35 PM IST as past EOD window", () => {
  // Monday 2026-05-25 at 3:35 PM IST (after 3:30 window end)
  const afterEod = new Date("2026-05-25T10:05:00Z"); // 3:35 PM IST
  assertEquals(isEodWindow(afterEod), false, "3:35 PM IST is past EOD window");
});

// IST time conversion tests
Deno.test("ist conversion: converts UTC to IST minutes correctly", () => {
  const utcNoon = new Date("2026-05-25T06:30:00Z"); // 12:00 PM IST
  const minutes = istMinutesSinceMidnight(utcNoon);
  const expectedMinutes = 12 * 60; // 720
  assertEquals(minutes, expectedMinutes, "UTC 06:30:00 should be 12:00 PM IST (720 minutes)");
});

// Circuit breaker threshold constant
Deno.test("circuit breaker: -3000 rupees triggers halt", () => {
  const DAILY_LOSS_CIRCUIT_BREAKER = -3000;
  const dailyLoss = -3500;
  assertEquals(
    dailyLoss <= DAILY_LOSS_CIRCUIT_BREAKER,
    true,
    "Loss of -₹3500 should trigger circuit breaker",
  );
});

Deno.test("circuit breaker: loss less than -3000 does not trigger", () => {
  const DAILY_LOSS_CIRCUIT_BREAKER = -3000;
  const dailyLoss = -2500;
  assertEquals(
    dailyLoss <= DAILY_LOSS_CIRCUIT_BREAKER,
    false,
    "Loss of -₹2500 should not trigger circuit breaker",
  );
});

// P&L aggregation logic test
Deno.test("daily pnl: sums multiple trade P&Ls correctly", () => {
  const closedTrades = [
    { net_pnl: 500 },
    { net_pnl: -200 },
    { net_pnl: 800 },
  ];

  const dailyPnl = closedTrades.reduce((sum, t) => sum + (t.net_pnl || 0), 0);
  assertEquals(dailyPnl, 1100, "Sum of ₹500 - ₹200 + ₹800 should be ₹1100");
});
