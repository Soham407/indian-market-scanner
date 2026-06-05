export type SignalSide = "long" | "short";

export type LifecycleStatus =
  | "research"
  | "shadow"
  | "paper_live_small"
  | "paper_live_normal"
  | "reduced"
  | "disabled";

export type SignalRow = {
  id: string;
  strategy_id: string;
  instrument_id: string;
  source: string;
  side: SignalSide;
  trigger_price: number;
  stop_loss_price: number;
  target_price: number;
  signal_time: string;
  metadata: Record<string, unknown>;
};

export type StrategyRow = {
  id: string;
  name: string;
  enabled: boolean;
  lifecycle_status: LifecycleStatus;
  risk_multiplier: number;
  max_risk_multiplier: number;
};

export type ExecutorContext = {
  tradingEnabled: boolean;
  baseRiskAmount: number;
  maxConcurrentPositions: number;
  maxTradesPerDay: number;
  openPositionCount: number;
  tradesTodayCount: number;
  hasDuplicateForInstrumentToday: boolean;
  latestPrice: number | null;
  nowIso: string;
};

export type ExecutorDecision =
  | { action: "reject"; reason: string }
  | { action: "shadow"; entryPrice: number; riskAmount: number }
  | {
      action: "paper_trade";
      entryPrice: number;
      stopLossPrice: number;
      targetPrice: number;
      shares: number;
      riskAmount: number;
      entrySlippagePct: number;
    };

const ENTRY_SLIPPAGE_RATE = 0.0005;
const MAX_RISK_MULTIPLIER = 1.5;
const PRICE_SANITY_PCT = 0.05;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function capRiskMultiplier(
  riskMultiplier: number,
  maxRiskMultiplier: number,
): number {
  return Math.max(0, Math.min(riskMultiplier, maxRiskMultiplier, MAX_RISK_MULTIPLIER));
}

export function applyEntrySlippage(
  side: SignalSide,
  triggerPrice: number,
): number {
  const raw = side === "long"
    ? triggerPrice * (1 + ENTRY_SLIPPAGE_RATE)
    : triggerPrice * (1 - ENTRY_SLIPPAGE_RATE);

  return Number(raw.toFixed(4));
}

export function calculateShares(
  baseRiskAmount: number,
  riskMultiplier: number,
  entryPrice: number,
  stopLossPrice: number,
): number {
  const riskPerShare = Math.abs(entryPrice - stopLossPrice);
  if (riskPerShare <= 0) return 0;

  return Math.floor((baseRiskAmount * riskMultiplier) / riskPerShare);
}

export function validateSignalShape(
  signal: Partial<SignalRow> | Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const side = signal.side;
  const triggerPrice = signal.trigger_price;
  const stopLossPrice = signal.stop_loss_price;
  const targetPrice = signal.target_price;

  if (side !== "long" && side !== "short") {
    return { ok: false, reason: "signal side must be long or short" };
  }

  if (
    !isFiniteNumber(triggerPrice) ||
    !isFiniteNumber(stopLossPrice) ||
    !isFiniteNumber(targetPrice) ||
    triggerPrice <= 0 ||
    stopLossPrice <= 0 ||
    targetPrice <= 0
  ) {
    return { ok: false, reason: "signal prices must be positive" };
  }

  if (side === "long") {
    if (stopLossPrice >= triggerPrice) {
      return { ok: false, reason: "long stop must be below trigger" };
    }
    if (targetPrice <= triggerPrice) {
      return { ok: false, reason: "long target must be above trigger" };
    }
  } else {
    if (stopLossPrice <= triggerPrice) {
      return { ok: false, reason: "short stop must be above trigger" };
    }
    if (targetPrice >= triggerPrice) {
      return { ok: false, reason: "short target must be below trigger" };
    }
  }

  return { ok: true };
}

function isPaperLiveStatus(status: LifecycleStatus): boolean {
  return (
    status === "paper_live_small" ||
    status === "paper_live_normal" ||
    status === "reduced"
  );
}

function isWithinSanityBand(
  triggerPrice: number,
  latestPrice: number | null,
): boolean {
  if (latestPrice === null) return true;
  if (!isFiniteNumber(latestPrice) || latestPrice <= 0) return false;

  return Math.abs(triggerPrice - latestPrice) / latestPrice <= PRICE_SANITY_PCT;
}

export function buildExecutorDecision(
  signal: SignalRow | Partial<SignalRow> | Record<string, unknown>,
  strategy: StrategyRow,
  context: ExecutorContext,
): ExecutorDecision {
  const shape = validateSignalShape(signal);
  if (!shape.ok) return { action: "reject", reason: shape.reason };

  const typedSignal = signal as SignalRow;

  if (!strategy.enabled || strategy.lifecycle_status === "disabled") {
    return { action: "reject", reason: "strategy disabled" };
  }

  if (strategy.lifecycle_status === "research") {
    return { action: "reject", reason: "strategy is research only" };
  }

  if (!isWithinSanityBand(typedSignal.trigger_price, context.latestPrice)) {
    return { action: "reject", reason: "trigger price outside sanity bounds" };
  }

  const riskMultiplier = capRiskMultiplier(
    strategy.risk_multiplier,
    strategy.max_risk_multiplier,
  );
  const entryPrice = applyEntrySlippage(typedSignal.side, typedSignal.trigger_price);
  const riskAmount = Number((context.baseRiskAmount * riskMultiplier).toFixed(4));

  if (strategy.lifecycle_status === "shadow") {
    return { action: "shadow", entryPrice, riskAmount };
  }

  if (!isPaperLiveStatus(strategy.lifecycle_status)) {
    return { action: "reject", reason: "unsupported strategy lifecycle" };
  }

  if (!context.tradingEnabled) {
    return { action: "reject", reason: "trading disabled" };
  }

  if (context.openPositionCount >= context.maxConcurrentPositions) {
    return { action: "reject", reason: "max concurrent positions reached" };
  }

  if (context.tradesTodayCount >= context.maxTradesPerDay) {
    return { action: "reject", reason: "max daily trades reached" };
  }

  if (context.hasDuplicateForInstrumentToday) {
    return {
      action: "reject",
      reason: "duplicate instrument for strategy today",
    };
  }

  const shares = calculateShares(
    context.baseRiskAmount,
    riskMultiplier,
    entryPrice,
    typedSignal.stop_loss_price,
  );

  if (shares <= 0) {
    return { action: "reject", reason: "position size is zero" };
  }

  return {
    action: "paper_trade",
    entryPrice,
    stopLossPrice: typedSignal.stop_loss_price,
    targetPrice: typedSignal.target_price,
    shares,
    riskAmount,
    entrySlippagePct: 0.05,
  };
}
