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
const DEFAULT_MAX_CONCURRENT_POSITIONS = 20;
const DEFAULT_MAX_TRADES_PER_DAY = 100;
const DEFAULT_SIGNAL_LIMIT = 100;
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
      .select("trading_enabled,max_concurrent_positions,max_daily_trades,signal_batch_limit")
      .eq("id", 1)
      .maybeSingle();

    if (settingsError) {
      return Response.json({ error: settingsError.message }, { status: 500 });
    }

    const tradingEnabled = settings?.trading_enabled ?? false;
    const maxConcurrentPositions = Number(settings?.max_concurrent_positions ?? DEFAULT_MAX_CONCURRENT_POSITIONS);
    const maxTradesPerDay = Number(settings?.max_daily_trades ?? DEFAULT_MAX_TRADES_PER_DAY);
    const signalLimit = Number(settings?.signal_batch_limit ?? DEFAULT_SIGNAL_LIMIT);

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

    const { data: processedSignals, error: processedSignalsError } = await supabase
      .from("bot_trade_signals")
      .select("strategy_id,instrument_id")
      .eq("status", "shadow_tracked")
      .gte("processed_at", dayStartIso)
      .lt("processed_at", nowIso);

    if (processedSignalsError) {
      return Response.json({ error: processedSignalsError.message }, { status: 500 });
    }

    const { data: signals, error: signalsError } = await supabase
      .from("bot_trade_signals")
      .select(
        "id,strategy_id,instrument_id,source,side,trigger_price,stop_loss_price,target_price,signal_time,metadata",
      )
      .eq("status", "pending")
      .order("signal_time", { ascending: true })
      .limit(signalLimit);

    if (signalsError) {
      return Response.json({ error: signalsError.message }, { status: 500 });
    }

    let accepted = 0;
    let rejected = 0;
    let shadowTracked = 0;
    let currentOpenPositionCount = openTrades?.length ?? 0;
    let currentTradesTodayCount = todaysTrades?.length ?? 0;
    const seenSignalKeys = new Set<string>(
      (processedSignals ?? []).map((signal) => `${signal.strategy_id}:${signal.instrument_id}:${dayStartIso.slice(0, 10)}`),
    );

    const rejectSignal = async (signalId: string, reason: string) => {
      const { error } = await supabase
        .from("bot_trade_signals")
        .update({
          status: "rejected",
          rejection_reason: reason,
          processed_at: nowIso,
        })
        .eq("id", signalId);
      if (error) {
        throw new Error(`failed to reject signal ${signalId}: ${error.message}`);
      }
    };

    for (const signal of (signals ?? []) as SignalRow[]) {
      const signalKey = `${signal.strategy_id}:${signal.instrument_id}:${dayStartIso.slice(0, 10)}`;
      const { data: strategy, error: strategyError } = await supabase
        .from("bot_strategies")
        .select("id,name,enabled,lifecycle_status,risk_multiplier,max_risk_multiplier")
        .eq("id", signal.strategy_id)
        .maybeSingle();

      if (strategyError || !strategy) {
        await rejectSignal(signal.id, strategyError?.message ?? "strategy not found");
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
        await rejectSignal(signal.id, candleError.message);
        rejected++;
        continue;
      }

      const hasDuplicateForInstrumentToday = (todaysTrades ?? []).some((trade) =>
        trade.strategy_id === signal.strategy_id &&
        trade.instrument_id === signal.instrument_id
      ) || seenSignalKeys.has(signalKey);

      const context: ExecutorContext = {
        tradingEnabled,
        baseRiskAmount: BASE_RISK_AMOUNT,
        maxConcurrentPositions,
        maxTradesPerDay,
        openPositionCount: currentOpenPositionCount,
        tradesTodayCount: currentTradesTodayCount,
        hasDuplicateForInstrumentToday,
        latestPrice: latestCandle?.close === null || latestCandle?.close === undefined
          ? null
          : Number(latestCandle.close),
        nowIso,
      };

      const decision = buildExecutorDecision(signal, strategy as StrategyRow, context);

      if (decision.action === "reject") {
        await rejectSignal(signal.id, decision.reason);
        rejected++;
        continue;
      }

      if (decision.action === "shadow") {
        const { error: shadowError } = await supabase.rpc("bot_track_shadow_signal", {
          p_signal_id: signal.id,
          p_entry_price: decision.entryPrice,
          p_processed_at: nowIso,
        });

        if (shadowError) {
          console.error(
            "[bot-signal-executor] failed to track shadow signal:",
            shadowError.message,
          );
          continue;
        }
        seenSignalKeys.add(signalKey);
        shadowTracked++;
        continue;
      }

      if (!tradingEnabled) {
        await rejectSignal(signal.id, "trading disabled");
        rejected++;
        continue;
      }

      const { data: paperTradeId, error: paperTradeError } = await supabase.rpc("bot_accept_paper_signal", {
        p_signal_id: signal.id,
        p_strategy_id: signal.strategy_id,
        p_instrument_id: signal.instrument_id,
        p_side: signal.side,
        p_entry_price: decision.entryPrice,
        p_entry_slippage_pct: decision.entrySlippagePct,
        p_stop_loss_price: decision.stopLossPrice,
        p_target_price: decision.targetPrice,
        p_shares: decision.shares,
        p_risk_amount: decision.riskAmount,
        p_processed_at: nowIso,
      });

      if (paperTradeError) {
        console.error(
          "[bot-signal-executor] failed to accept paper signal:",
          paperTradeError.message,
        );
        continue;
      }
      if (!paperTradeId) {
        console.error("[bot-signal-executor] signal was already processed before paper acceptance:", signal.id);
        continue;
      }

      const meta = signal.metadata as Record<string, unknown> | null;
      const telegramSymbol = typeof meta?.symbol === "string" && meta.symbol.length > 0
        ? meta.symbol
        : typeof meta?.alert_title === "string" && meta.alert_title.length > 0
        ? meta.alert_title.split(" ")[0]
        : signal.source;

      const telegramResult = await sendTelegramNotification({
        type: "entry",
        symbol: telegramSymbol,
        side: signal.side,
        entryPrice: decision.entryPrice,
        targetPrice: decision.targetPrice,
        stopLossPrice: decision.stopLossPrice,
        riskAmount: decision.riskAmount,
        shares: decision.shares,
        timestamp: nowIso,
      });

      if (!telegramResult.success) {
        console.error("[bot-signal-executor] telegram notification failed:", telegramResult.error);
      }

      accepted++;
      currentOpenPositionCount += 1;
      currentTradesTodayCount += 1;
      seenSignalKeys.add(signalKey);
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
