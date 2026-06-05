import { createServiceClient } from "../_shared/supabase.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import {
  calculateFeedbackMetrics,
  decideLifecycleTransition,
  type FeedbackStrategy,
  type FeedbackTrade,
} from "./feedback.ts";

const REVIEW_WINDOW_DAYS = 30;

function isoDaysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

Deno.serve(async () => {
  const supabase = createServiceClient();
  const now = new Date();
  const windowEnd = now.toISOString();
  const windowStart = isoDaysAgo(REVIEW_WINDOW_DAYS, now);

  const { data: strategies, error: strategiesError } = await supabase
    .from("bot_strategies")
    .select("id,name,lifecycle_status,risk_multiplier,max_risk_multiplier,enabled,promotion_thresholds")
    .eq("enabled", true);

  if (strategiesError) {
    return Response.json({ error: strategiesError.message }, { status: 500 });
  }

  let reviewed = 0;
  let changed = 0;

  for (const strategyRow of (strategies ?? []) as FeedbackStrategy[]) {
    const { data: closedTrades, error: tradesError } = await supabase
      .from("bot_paper_trades")
      .select("net_pnl,risk_amount,status,exit_time,entry_time")
      .eq("strategy_id", strategyRow.id)
      .eq("status", "closed")
      .gte("exit_time", windowStart)
      .lt("exit_time", windowEnd)
      .order("exit_time", { ascending: true });

    if (tradesError) {
      return Response.json({ error: tradesError.message, strategy_id: strategyRow.id }, { status: 500 });
    }

    const { count: rejectedSignals, error: rejectedError } = await supabase
      .from("bot_trade_signals")
      .select("id", { count: "exact", head: true })
      .eq("strategy_id", strategyRow.id)
      .eq("status", "rejected")
      .gte("processed_at", windowStart)
      .lt("processed_at", windowEnd);

    if (rejectedError) {
      return Response.json({ error: rejectedError.message, strategy_id: strategyRow.id }, { status: 500 });
    }

    const metrics = calculateFeedbackMetrics((closedTrades ?? []) as FeedbackTrade[], rejectedSignals ?? 0);
    const decision = decideLifecycleTransition(strategyRow, metrics);

    const { error: reviewError } = await supabase.from("bot_strategy_reviews").insert({
      strategy_id: strategyRow.id,
      window_start: windowStart,
      window_end: windowEnd,
      sample_count: metrics.sampleCount,
      profit_factor: finiteOrNull(metrics.profitFactor),
      win_rate: finiteOrNull(metrics.winRate),
      average_r: finiteOrNull(metrics.averageR),
      max_drawdown: metrics.maxDrawdown,
      rejection_rate: metrics.rejectionRate,
      previous_status: strategyRow.lifecycle_status,
      new_status: decision.newStatus,
      previous_risk_multiplier: strategyRow.risk_multiplier,
      new_risk_multiplier: decision.newRiskMultiplier,
      decision: decision.decision,
      rationale: decision.rationale,
      metrics: {
        sample_count: metrics.sampleCount,
        profit_factor: metrics.profitFactor,
        win_rate: metrics.winRate,
        average_r: metrics.averageR,
        max_drawdown: metrics.maxDrawdown,
        rejection_rate: metrics.rejectionRate,
      },
    });

    if (reviewError) {
      return Response.json({ error: reviewError.message, strategy_id: strategyRow.id }, { status: 500 });
    }

    reviewed++;

    const statusChanged = decision.newStatus !== strategyRow.lifecycle_status;
    const riskChanged = decision.newRiskMultiplier !== Number(strategyRow.risk_multiplier);

    const { error: updateError } = await supabase
      .from("bot_strategies")
      .update({
        lifecycle_status: decision.newStatus,
        risk_multiplier: decision.newRiskMultiplier,
        last_reviewed_at: windowEnd,
      })
      .eq("id", strategyRow.id);

    if (updateError) {
      return Response.json({ error: updateError.message, strategy_id: strategyRow.id }, { status: 500 });
    }

    if (statusChanged || riskChanged) {
      changed++;
      const telegramResult = await sendTelegramNotification({
        type: "heartbeat",
        symbol: "BOT",
        timestamp: windowEnd,
        message: `Strategy ${strategyRow.name} ${decision.decision}: ${decision.rationale}`,
      });

      if (!telegramResult.success) {
        console.error("[bot-feedback-run] telegram notification failed:", telegramResult.error);
      }
    }
  }

  return Response.json({
    ok: true,
    reviewed,
    changed,
    window_start: windowStart,
    window_end: windowEnd,
  });
});
