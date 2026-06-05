import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateFeedbackMetrics,
  decideLifecycleTransition,
  type FeedbackStrategy,
} from "./feedback.ts";

const strategy: FeedbackStrategy = {
  id: "strategy-1",
  lifecycle_status: "paper_live_small",
  risk_multiplier: 0.25,
  max_risk_multiplier: 1.5,
};

function closedTrade(netPnl: number, riskAmount = 1000, exitTime = "2026-06-05T10:00:00.000Z") {
  return {
    net_pnl: netPnl,
    risk_amount: riskAmount,
    status: "closed",
    entry_time: "2026-06-05T09:30:00.000Z",
    exit_time: exitTime,
  };
}

Deno.test("calculateFeedbackMetrics computes profit factor and drawdown", () => {
  const metrics = calculateFeedbackMetrics(
    [closedTrade(100), closedTrade(200, 1000, "2026-06-05T10:05:00.000Z"), closedTrade(-100, 1000, "2026-06-05T10:10:00.000Z")],
    1,
  );

  assertEquals(metrics.sampleCount, 3);
  assertEquals(metrics.profitFactor, 3);
  assertEquals(metrics.winRate, 2 / 3);
  assertEquals(metrics.maxDrawdown, 100);
  assertEquals(metrics.rejectionRate, 0.25);
});

Deno.test("decideLifecycleTransition promotes paper_live_small after enough profitable trades", () => {
  const metrics = calculateFeedbackMetrics(
    [...Array(30).fill(0)].map((_, index) => closedTrade(index < 25 ? 120 : 40, 1000, `2026-06-05T10:${String(index).padStart(2, "0")}:00.000Z`)),
    0,
  );

  const decision = decideLifecycleTransition(strategy, metrics);
  assertEquals(decision.decision, "promote");
  assertEquals(decision.newStatus, "paper_live_normal");
});

Deno.test("decideLifecycleTransition reduces weak live strategy", () => {
  const metrics = calculateFeedbackMetrics(
    [...Array(10).fill(0)].map((_, index) => closedTrade(index < 4 ? 100 : -150, 1000, `2026-06-05T10:${String(index).padStart(2, "0")}:00.000Z`)),
    0,
  );

  const decision = decideLifecycleTransition(
    { ...strategy, lifecycle_status: "paper_live_normal", risk_multiplier: 1 },
    metrics,
  );

  assertEquals(decision.decision, "reduce");
  assertEquals(decision.newStatus, "reduced");
  assertEquals(decision.newRiskMultiplier, 0.5);
});

Deno.test("decideLifecycleTransition disables when rejection rate is too high", () => {
  const metrics = calculateFeedbackMetrics(
    [...Array(10).fill(0)].map((_, index) => closedTrade(100, 1000, `2026-06-05T10:${String(index).padStart(2, "0")}:00.000Z`)),
    10,
  );
  const decision = decideLifecycleTransition(strategy, metrics);
  assertEquals(decision.decision, "disable");
  assertEquals(decision.newStatus, "disabled");
});

Deno.test("decideLifecycleTransition caps risk at 1.5", () => {
  const metrics = calculateFeedbackMetrics(
    [...Array(30).fill(0)].map((_, index) => closedTrade(150, 1000, `2026-06-05T10:${String(index).padStart(2, "0")}:00.000Z`)),
    0,
  );

  const decision = decideLifecycleTransition(
    { ...strategy, lifecycle_status: "paper_live_small", risk_multiplier: 2, max_risk_multiplier: 2 },
    metrics,
  );

  assertEquals(decision.newRiskMultiplier, 1.5);
});
