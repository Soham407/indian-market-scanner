import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyEntrySlippage,
  buildExecutorDecision,
  calculateShares,
  capRiskMultiplier,
  validateSignalShape,
  type ExecutorContext,
  type SignalRow,
  type StrategyRow,
} from "./executor.ts";

const baseSignal: SignalRow = {
  id: "signal-1",
  strategy_id: "strategy-1",
  instrument_id: "instrument-1",
  source: "orb_breakout",
  side: "long",
  trigger_price: 100,
  stop_loss_price: 95,
  target_price: 110,
  signal_time: "2026-06-05T04:00:00.000Z",
  metadata: {},
};

const liveStrategy: StrategyRow = {
  id: "strategy-1",
  name: "orb_breakout",
  enabled: true,
  lifecycle_status: "paper_live_small",
  risk_multiplier: 0.25,
  max_risk_multiplier: 1.5,
};

const context: ExecutorContext = {
  tradingEnabled: true,
  baseRiskAmount: 1000,
  maxConcurrentPositions: 2,
  maxTradesPerDay: 6,
  openPositionCount: 0,
  tradesTodayCount: 0,
  hasDuplicateForInstrumentToday: false,
  latestPrice: 100,
  nowIso: "2026-06-05T04:01:00.000Z",
};

Deno.test("validateSignalShape rejects invalid long stop and target geometry", () => {
  assertEquals(validateSignalShape({ ...baseSignal, stop_loss_price: 101 }).ok, false);
  assertEquals(validateSignalShape({ ...baseSignal, target_price: 99 }).ok, false);
});

Deno.test("validateSignalShape rejects invalid short stop and target geometry", () => {
  const shortSignal = {
    ...baseSignal,
    side: "short" as const,
    trigger_price: 100,
    stop_loss_price: 95,
    target_price: 110,
  };
  assertEquals(validateSignalShape(shortSignal).ok, false);
});

Deno.test("validateSignalShape rejects malformed signals", () => {
  assertEquals(validateSignalShape({} as never).ok, false);
});

Deno.test("capRiskMultiplier never exceeds 1.5", () => {
  assertEquals(capRiskMultiplier(2, 2), 1.5);
  assertEquals(capRiskMultiplier(1.25, 2), 1.25);
});

Deno.test("applyEntrySlippage applies slippage against long and short entries", () => {
  assertEquals(applyEntrySlippage("long", 100), 100.05);
  assertEquals(applyEntrySlippage("short", 100), 99.95);
});

Deno.test("calculateShares sizes from effective risk and per-share risk", () => {
  assertEquals(calculateShares(1000, 0.25, 100.05, 95), 49);
});

Deno.test("buildExecutorDecision creates shadow outcome without paper trade", () => {
  const decision = buildExecutorDecision(
    baseSignal,
    { ...liveStrategy, lifecycle_status: "shadow" },
    { ...context, tradingEnabled: false },
  );
  assertEquals(decision.action, "shadow");
});

Deno.test("buildExecutorDecision rejects paper entry when kill switch is disabled", () => {
  const decision = buildExecutorDecision(baseSignal, liveStrategy, {
    ...context,
    tradingEnabled: false,
  });
  assertEquals(decision.action, "reject");
  if (decision.action !== "reject") throw new Error("expected reject");
  assertEquals(decision.reason, "trading disabled");
});

Deno.test("buildExecutorDecision accepts live paper strategy and caps risk", () => {
  const decision = buildExecutorDecision(
    baseSignal,
    { ...liveStrategy, risk_multiplier: 3, max_risk_multiplier: 3 },
    context,
  );
  assertEquals(decision.action, "paper_trade");
  if (decision.action !== "paper_trade") throw new Error("expected paper trade");
  assertEquals(decision.riskAmount, 1500);
  assertEquals(decision.shares, 297);
});

Deno.test("buildExecutorDecision accepts reduced lifecycle as paper trade", () => {
  const decision = buildExecutorDecision(
    baseSignal,
    { ...liveStrategy, lifecycle_status: "reduced" },
    context,
  );
  assertEquals(decision.action, "paper_trade");
  if (decision.action !== "paper_trade") throw new Error("expected paper trade");
  assertEquals(decision.entryPrice, 100.05);
});

Deno.test("buildExecutorDecision rejects duplicate same-instrument day trade", () => {
  const decision = buildExecutorDecision(baseSignal, liveStrategy, {
    ...context,
    hasDuplicateForInstrumentToday: true,
  });
  assertEquals(decision.action, "reject");
  if (decision.action !== "reject") throw new Error("expected reject");
  assertEquals(decision.reason, "duplicate instrument for strategy today");
});

Deno.test("buildExecutorDecision rejects when max concurrent positions is reached", () => {
  const decision = buildExecutorDecision(baseSignal, liveStrategy, {
    ...context,
    openPositionCount: 2,
  });
  assertEquals(decision.action, "reject");
  if (decision.action !== "reject") throw new Error("expected reject");
  assertEquals(decision.reason, "max concurrent positions reached");
});

Deno.test("buildExecutorDecision rejects when max daily trades is reached", () => {
  const decision = buildExecutorDecision(baseSignal, liveStrategy, {
    ...context,
    tradesTodayCount: 6,
  });
  assertEquals(decision.action, "reject");
  if (decision.action !== "reject") throw new Error("expected reject");
  assertEquals(decision.reason, "max daily trades reached");
});

Deno.test("buildExecutorDecision rejects malformed signal rows", () => {
  const decision = buildExecutorDecision(
    {
      ...baseSignal,
      trigger_price: undefined as never,
    },
    liveStrategy,
    context,
  );
  assertEquals(decision.action, "reject");
  if (decision.action !== "reject") throw new Error("expected reject");
  assertEquals(decision.reason, "signal prices must be positive");
});

Deno.test("buildExecutorDecision rejects research and disabled strategies", () => {
  const research = buildExecutorDecision(
    baseSignal,
    { ...liveStrategy, lifecycle_status: "research" },
    context,
  );
  assertEquals(research.action, "reject");
  if (research.action !== "reject") throw new Error("expected reject");
  assertEquals(research.reason, "strategy is research only");

  const disabled = buildExecutorDecision(
    baseSignal,
    { ...liveStrategy, enabled: false },
    context,
  );
  assertEquals(disabled.action, "reject");
  if (disabled.action !== "reject") throw new Error("expected reject");
  assertEquals(disabled.reason, "strategy disabled");
});
