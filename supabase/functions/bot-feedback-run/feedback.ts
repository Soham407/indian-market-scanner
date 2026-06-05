export type LifecycleStatus =
  | "research"
  | "shadow"
  | "paper_live_small"
  | "paper_live_normal"
  | "reduced"
  | "disabled";

export type FeedbackTrade = {
  net_pnl: number | null;
  risk_amount: number | null;
  status: string;
  exit_time: string | null;
  entry_time: string;
};

export type FeedbackStrategy = {
  id: string;
  name?: string;
  enabled?: boolean;
  lifecycle_status: LifecycleStatus;
  risk_multiplier: number;
  max_risk_multiplier: number;
  promotion_thresholds?: Record<string, unknown> | null;
};

export type FeedbackMetrics = {
  sampleCount: number;
  profitFactor: number | null;
  winRate: number | null;
  averageR: number | null;
  maxDrawdown: number;
  rejectionRate: number;
};

export type LifecycleDecision = {
  decision: "promote" | "reduce" | "disable" | "hold";
  newStatus: LifecycleStatus;
  newRiskMultiplier: number;
  rationale: string;
};

const HARD_MAX_RISK_MULTIPLIER = 1.5;

function capRiskMultiplier(value: number, maxRisk: number): number {
  return Math.min(Math.max(value, 0), maxRisk, HARD_MAX_RISK_MULTIPLIER);
}

function getThreshold(
  thresholds: Record<string, unknown> | null | undefined,
  key: string,
  fallback: number,
): number {
  const value = thresholds?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function calculateFeedbackMetrics(
  trades: FeedbackTrade[],
  rejectedSignals: number,
): FeedbackMetrics {
  const closed = trades
    .filter((trade) => trade.status === "closed" && trade.net_pnl !== null)
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.exit_time ?? a.entry_time).getTime();
      const bTime = new Date(b.exit_time ?? b.entry_time).getTime();
      return aTime - bTime;
    });

  const wins = closed.filter((trade) => (trade.net_pnl ?? 0) > 0);
  const losses = closed.filter((trade) => (trade.net_pnl ?? 0) < 0);
  const grossWins = wins.reduce((sum, trade) => sum + (trade.net_pnl ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + (trade.net_pnl ?? 0), 0));
  const rValues = closed
    .map((trade) => trade.risk_amount && trade.risk_amount > 0
      ? (trade.net_pnl ?? 0) / trade.risk_amount
      : null)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of closed) {
    equity += trade.net_pnl ?? 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const totalSignals = closed.length + rejectedSignals;

  return {
    sampleCount: closed.length,
    profitFactor: grossLosses === 0
      ? (grossWins > 0 ? Number.POSITIVE_INFINITY : null)
      : grossWins / grossLosses,
    winRate: closed.length > 0 ? wins.length / closed.length : null,
    averageR: rValues.length > 0
      ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length
      : null,
    maxDrawdown,
    rejectionRate: totalSignals > 0 ? rejectedSignals / totalSignals : 0,
  };
}

export function decideLifecycleTransition(
  strategy: FeedbackStrategy,
  metrics: FeedbackMetrics,
): LifecycleDecision {
  const currentRisk = capRiskMultiplier(strategy.risk_multiplier, strategy.max_risk_multiplier);
  const maxDrawdownLimit = getThreshold(strategy.promotion_thresholds, "max_drawdown_limit", 3000);
  const shadowMinOutcomes = getThreshold(strategy.promotion_thresholds, "shadow_min_outcomes", 30);
  const shadowMinProfitFactor = getThreshold(strategy.promotion_thresholds, "shadow_min_profit_factor", 1.1);
  const shadowMinAverageR = getThreshold(strategy.promotion_thresholds, "shadow_min_average_r", 0);
  const normalMinLiveTrades = getThreshold(strategy.promotion_thresholds, "normal_min_live_trades", 30);
  const normalMinProfitFactor = getThreshold(strategy.promotion_thresholds, "normal_min_profit_factor", 1.2);

  const profitFactor = metrics.profitFactor ?? 0;
  const averageR = metrics.averageR ?? 0;
  const exceedsDrawdownLimit = metrics.maxDrawdown > maxDrawdownLimit;

  if (metrics.rejectionRate >= 0.5 && metrics.sampleCount >= 10) {
    return {
      decision: "disable",
      newStatus: "disabled",
      newRiskMultiplier: 0,
      rationale: `Disabled because rejection rate ${(metrics.rejectionRate * 100).toFixed(1)}% is too high.`,
    };
  }

  if (
    (strategy.lifecycle_status === "paper_live_small" || strategy.lifecycle_status === "paper_live_normal" || strategy.lifecycle_status === "reduced") &&
    metrics.sampleCount >= 10 &&
    (profitFactor < 1.0 || exceedsDrawdownLimit)
  ) {
    const newRisk = capRiskMultiplier(currentRisk * 0.5, strategy.max_risk_multiplier);
    return {
      decision: "reduce",
      newStatus: "reduced",
      newRiskMultiplier: newRisk,
      rationale: exceedsDrawdownLimit
        ? `Reduced because max drawdown ${metrics.maxDrawdown.toFixed(2)} exceeded the configured limit.`
        : `Reduced because rolling profit factor ${profitFactor.toFixed(2)} is below 1.00.`,
    };
  }

  if (strategy.lifecycle_status === "shadow") {
    return {
      decision: "hold",
      newStatus: "shadow",
      newRiskMultiplier: currentRisk,
      rationale: `Held in shadow with ${metrics.sampleCount} closed outcomes tracked.`,
    };
  }

  if (strategy.lifecycle_status === "paper_live_small") {
    if (
      metrics.sampleCount >= normalMinLiveTrades &&
      profitFactor >= normalMinProfitFactor &&
      averageR > 0 &&
      !exceedsDrawdownLimit
    ) {
      return {
        decision: "promote",
        newStatus: "paper_live_normal",
        newRiskMultiplier: capRiskMultiplier(Math.max(currentRisk, 1.0), strategy.max_risk_multiplier),
        rationale: `Promoted to normal paper risk after ${metrics.sampleCount} live trades with profit factor ${profitFactor.toFixed(2)}.`,
      };
    }

    return {
      decision: "hold",
      newStatus: "paper_live_small",
      newRiskMultiplier: currentRisk,
      rationale: `Held paper_live_small with ${metrics.sampleCount} live trades.`,
    };
  }

  if (strategy.lifecycle_status === "paper_live_normal") {
    if (exceedsDrawdownLimit || profitFactor < 1.0) {
      const newRisk = capRiskMultiplier(currentRisk * 0.5, strategy.max_risk_multiplier);
      return {
        decision: "reduce",
        newStatus: "reduced",
        newRiskMultiplier: newRisk,
        rationale: exceedsDrawdownLimit
          ? `Reduced because max drawdown ${metrics.maxDrawdown.toFixed(2)} exceeded the configured limit.`
          : `Reduced because rolling profit factor ${profitFactor.toFixed(2)} is below 1.00.`,
      };
    }

    return {
      decision: "hold",
      newStatus: "paper_live_normal",
      newRiskMultiplier: currentRisk,
      rationale: `Held paper_live_normal with ${metrics.sampleCount} live trades.`,
    };
  }

  if (strategy.lifecycle_status === "research") {
    if (
      metrics.sampleCount >= shadowMinOutcomes &&
      profitFactor >= shadowMinProfitFactor &&
      averageR > shadowMinAverageR &&
      !exceedsDrawdownLimit
    ) {
      return {
        decision: "promote",
        newStatus: "shadow",
        newRiskMultiplier: capRiskMultiplier(0.25, strategy.max_risk_multiplier),
        rationale: `Moved from research into shadow after ${metrics.sampleCount} confirmed trades.`,
      };
    }

    return {
      decision: "hold",
      newStatus: "research",
      newRiskMultiplier: currentRisk,
      rationale: `Held research with ${metrics.sampleCount} trades.`,
    };
  }

  return {
    decision: "hold",
    newStatus: strategy.lifecycle_status,
    newRiskMultiplier: currentRisk,
    rationale: `Held ${strategy.lifecycle_status} with ${metrics.sampleCount} trades.`,
  };
}
