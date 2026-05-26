import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Stale data detection constants
Deno.test("stale data: detects candle older than 5 minutes", () => {
  const STALE_CANDLE_THRESHOLD_MINUTES = 5;
  const now = new Date();
  const candleTime = new Date(now.getTime() - 6 * 60 * 1000); // 6 minutes old

  const candleAge = (now.getTime() - candleTime.getTime()) / 1000 / 60;
  assertEquals(candleAge > STALE_CANDLE_THRESHOLD_MINUTES, true);
});

Deno.test("stale data: accepts candle within 5 minutes", () => {
  const STALE_CANDLE_THRESHOLD_MINUTES = 5;
  const now = new Date();
  const candleTime = new Date(now.getTime() - 3 * 60 * 1000); // 3 minutes old

  const candleAge = (now.getTime() - candleTime.getTime()) / 1000 / 60;
  assertEquals(candleAge > STALE_CANDLE_THRESHOLD_MINUTES, false);
});

// Heartbeat interval logic
Deno.test("heartbeat: calculates interval correctly", () => {
  const HEARTBEAT_INTERVAL_MINUTES = 15;
  const now = new Date();
  const lastHeartbeat = new Date(now.getTime() - 20 * 60 * 1000); // 20 minutes ago

  const timeSinceLastHeartbeat = (now.getTime() - lastHeartbeat.getTime()) / 1000 / 60;
  assertEquals(
    timeSinceLastHeartbeat > HEARTBEAT_INTERVAL_MINUTES,
    true,
    "Should trigger heartbeat after 20 minutes",
  );
});

Deno.test("heartbeat: skips if interval not reached", () => {
  const HEARTBEAT_INTERVAL_MINUTES = 15;
  const now = new Date();
  const lastHeartbeat = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

  const timeSinceLastHeartbeat = (now.getTime() - lastHeartbeat.getTime()) / 1000 / 60;
  assertEquals(
    timeSinceLastHeartbeat > HEARTBEAT_INTERVAL_MINUTES,
    false,
    "Should not trigger heartbeat before interval",
  );
});

// Daily P&L aggregation for health monitoring
Deno.test("health: aggregates daily P&L correctly", () => {
  const closedTrades = [
    { net_pnl: 250 },
    { net_pnl: -100 },
    { net_pnl: 450 },
  ];

  const dailyPnl = closedTrades.reduce((sum, t) => sum + (t.net_pnl || 0), 0);
  assertEquals(dailyPnl, 600);
});

Deno.test("health: handles empty trade list", () => {
  const closedTrades: { net_pnl: number }[] = [];
  const dailyPnl = closedTrades.reduce((sum, t) => sum + (t.net_pnl || 0), 0);
  assertEquals(dailyPnl, 0);
});

// Health status determination
Deno.test("health: marks degraded if many instruments stale", () => {
  const staleCandlesDetected = 10;
  const threshold = 5;
  const health = staleCandlesDetected > threshold ? "degraded" : "healthy";
  assertEquals(health, "degraded");
});

Deno.test("health: marks healthy if few instruments stale", () => {
  const staleCandlesDetected = 3;
  const threshold = 5;
  const health = staleCandlesDetected > threshold ? "degraded" : "healthy";
  assertEquals(health, "healthy");
});

// Status message construction
Deno.test("health: constructs status with trading enabled", () => {
  const tradingEnabled = true;
  const circuitBreakerActive = false;
  const openTradesCount = 2;

  const status = circuitBreakerActive
    ? "⛔ Circuit breaker active"
    : tradingEnabled
      ? `✅ Trading active (${openTradesCount} open)`
      : "🛑 Trading disabled";

  assertEquals(status, "✅ Trading active (2 open)");
});

Deno.test("health: constructs status with circuit breaker active", () => {
  const tradingEnabled = true;
  const circuitBreakerActive = true;
  const openTradesCount = 0;

  const status = circuitBreakerActive
    ? "⛔ Circuit breaker active"
    : tradingEnabled
      ? `✅ Trading active (${openTradesCount} open)`
      : "🛑 Trading disabled";

  assertEquals(status, "⛔ Circuit breaker active");
});

Deno.test("health: constructs status with trading disabled", () => {
  const tradingEnabled = false;
  const circuitBreakerActive = false;
  const openTradesCount = 0;

  const status = circuitBreakerActive
    ? "⛔ Circuit breaker active"
    : tradingEnabled
      ? `✅ Trading active (${openTradesCount} open)`
      : "🛑 Trading disabled";

  assertEquals(status, "🛑 Trading disabled");
});
