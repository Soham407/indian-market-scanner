import { createServiceClient } from "../_shared/supabase.ts";
import {
  getMarketSessionStatus,
  marketClosedResponse,
} from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import {
  buildExecutorDecision,
  type ExecutorContext,
  type SignalRow,
  type StrategyRow,
} from "./executor.ts";

const BASE_RISK_AMOUNT = 1000;
const MAX_CONCURRENT_POSITIONS = 2;
const MAX_TRADES_PER_DAY = 6;
const SIGNAL_LIMIT = 25;
const IST_OFFSET_MS = 330 * 60 * 1000;

function istDayStartIso(now: Date): string {
  const istDate = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return `${istDate}T00:00:00Z`;
}

Deno.serve(async () => {
  const now = new Date();
  if (!getMarketSessionStatus(now).isOpen) {
    return marketClosedResponse(now);
  }

  try {
    const supabase = createServiceClient();
    const nowIso = now.toISOString();
    const dayStartIso = istDayStartIso(now);

    const { data: settings, error: settingsError } = await supabase
      .from("bot_settings")
      .select("trading_enabled")
      .eq("id", 1)
      .maybeSingle();

    if (settingsError) {
      return Response.json({ error: settingsError.message }, { status: 500 });
    }

    const tradingEnabled = settings?.trading_enabled ?? false;

    const { data: openTrades, error: openTradesError } = await supabase
      .from("bot_paper_trades")
      .select("strategy_id,instrument_id")
      .eq("status", "open");

    if (openTradesError) {
      return Response.json({ error: openTradesError.message }, { status: 500 });
    }

    const { data: todaysTrades, error: todaysTradesError } = await supabase
      .from("bot_paper_trades")
      .select("strategy_id,instrument_id")
      .gte("entry_time", dayStartIso)
      .lt("entry_time", nowIso);

    if (todaysTradesError) {
      return Response.json({ error: todaysTradesError.message }, { status: 500 });
    }

    const { data: signals, error: signalsError } = await supabase
      .from("bot_trade_signals")
      .select(
        "id,strategy_id,instrument_id,source,side,trigger_price,stop_loss_price,target_price,signal_time,metadata",
      )
      .eq("status", "pending")
      .order("signal_time", { ascending: true })
      .limit(SIGNAL_LIMIT);

    if (signalsError) {
      return Response.json({ error: signalsError.message }, { status: 500 });
    }

    let accepted = 0;
    let rejected = 0;
    let shadowTracked = 0;

    for (const signal of (signals ?? []) as SignalRow[]) {
      const { data: strategy, error: strategyError } = await supabase
        .from("bot_strategies")
        .select("id,name,enabled,lifecycle_status,risk_multiplier,max_risk_multiplier")
        .eq("id", signal.strategy_id)
        .maybeSingle();

      if (strategyError || !strategy) {
        await supabase
          .from("bot_trade_signals")
          .update({
            status: "rejected",
            rejection_reason: strategyError?.message ?? "strategy not found",
            processed_at: nowIso,
          })
          .eq("id", signal.id);
        rejected++;
        continue;
      }

      const { data: latestCandle, error: candleError } = await supabase
        .from("bot_candles")
        .select("close")
        .eq("instrument_id", signal.instrument_id)
        .eq("timeframe", "1m")
        .order("candle_open_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (candleError) {
        await supabase
          .from("bot_trade_signals")
          .update({
            status: "rejected",
            rejection_reason: candleError.message,
            processed_at: nowIso,
          })
          .eq("id", signal.id);
        rejected++;
        continue;
      }

      const hasDuplicateForInstrumentToday = (todaysTrades ?? []).some((trade) =>
        trade.strategy_id === signal.strategy_id &&
        trade.instrument_id === signal.instrument_id
      );

      const context: ExecutorContext = {
        tradingEnabled,
        baseRiskAmount: BASE_RISK_AMOUNT,
        maxConcurrentPositions: MAX_CONCURRENT_POSITIONS,
        maxTradesPerDay: MAX_TRADES_PER_DAY,
        openPositionCount: openTrades?.length ?? 0,
        tradesTodayCount: todaysTrades?.length ?? 0,
        hasDuplicateForInstrumentToday,
        latestPrice: latestCandle?.close === null || latestCandle?.close === undefined
          ? null
          : Number(latestCandle.close),
        nowIso,
      };

      const decision = buildExecutorDecision(signal, strategy as StrategyRow, context);

      if (decision.action === "reject") {
        await supabase
          .from("bot_trade_signals")
          .update({
            status: "rejected",
            rejection_reason: decision.reason,
            processed_at: nowIso,
          })
          .eq("id", signal.id);
        rejected++;
        continue;
      }

      if (decision.action === "shadow") {
        const { error: outcomeError } = await supabase
          .from("bot_signal_outcomes")
          .insert({
            signal_id: signal.id,
            mode: "shadow",
            entry_price: decision.entryPrice,
            status: "open",
            opened_at: nowIso,
          });

        if (outcomeError) {
          await supabase
            .from("bot_trade_signals")
            .update({
              status: "rejected",
              rejection_reason: outcomeError.message,
              processed_at: nowIso,
            })
            .eq("id", signal.id);
          rejected++;
          continue;
        }

        await supabase
          .from("bot_trade_signals")
          .update({
            status: "shadow_tracked",
            processed_at: nowIso,
          })
          .eq("id", signal.id);
        shadowTracked++;
        continue;
      }

      if (!tradingEnabled) {
        await supabase
          .from("bot_trade_signals")
          .update({
            status: "rejected",
            rejection_reason: "trading disabled",
            processed_at: nowIso,
          })
          .eq("id", signal.id);
        rejected++;
        continue;
      }

      const { data: trade, error: tradeError } = await supabase
        .from("bot_paper_trades")
        .insert({
          strategy_id: signal.strategy_id,
          instrument_id: signal.instrument_id,
          side: signal.side,
          entry_price: decision.entryPrice,
          entry_time: nowIso,
          entry_slippage_pct: decision.entrySlippagePct,
          stop_loss_price: decision.stopLossPrice,
          target_price: decision.targetPrice,
          shares: decision.shares,
          status: "open",
          risk_amount: decision.riskAmount,
        })
        .select("id")
        .single();

      if (tradeError || !trade) {
        await supabase
          .from("bot_trade_signals")
          .update({
            status: "rejected",
            rejection_reason: tradeError?.message ?? "trade insert failed",
            processed_at: nowIso,
          })
          .eq("id", signal.id);
        rejected++;
        continue;
      }

      const { error: outcomeError } = await supabase
        .from("bot_signal_outcomes")
        .insert({
          signal_id: signal.id,
          paper_trade_id: trade.id,
          mode: "paper_live",
          entry_price: decision.entryPrice,
          status: "open",
          opened_at: nowIso,
        });

      if (outcomeError) {
        await supabase
          .from("bot_trade_signals")
          .update({
            status: "rejected",
            rejection_reason: outcomeError.message,
            processed_at: nowIso,
          })
          .eq("id", signal.id);
        rejected++;
        continue;
      }

      await supabase
        .from("bot_trade_signals")
        .update({
          status: "accepted",
          processed_at: nowIso,
        })
        .eq("id", signal.id);

      await sendTelegramNotification({
        type: "entry",
        symbol: signal.source,
        side: signal.side,
        entryPrice: decision.entryPrice,
        targetPrice: decision.targetPrice,
        stopLossPrice: decision.stopLossPrice,
        riskAmount: decision.riskAmount,
        shares: decision.shares,
        timestamp: nowIso,
      });

      accepted++;
    }

    return Response.json({
      ok: true,
      accepted,
      rejected,
      shadow_tracked: shadowTracked,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
});
