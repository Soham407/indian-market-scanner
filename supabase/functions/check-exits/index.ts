import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";

const BROKERAGE_PER_LEG = 20;
const STATUTORY_FEE_PCT = 0.0005; // 0.05%

Deno.serve(async () => {
  const session = getMarketSessionStatus();
  if (!session.isOpen) {
    return Response.json({ status: "Market closed", exits_processed: 0 });
  }

  const supabase = createServiceClient();
  let exitsProcessed = 0;

  // Get all open trades with instrument info
  const { data: openTrades, error: tradesError } = await supabase
    .from("bot_paper_trades")
    .select(
      "id,instrument_id,side,entry_price,stop_loss_price,target_price,shares,risk_amount,instruments(symbol,name)",
    )
    .eq("status", "open");

  if (tradesError || !openTrades) {
    return Response.json({ error: tradesError?.message, exits_processed: 0 });
  }

  for (const trade of openTrades) {
    // Fetch latest 1-min candle for this instrument
    const { data: candles, error: candleError } = await supabase
      .from("bot_candles")
      .select("high,low,close,candle_open_at")
      .eq("instrument_id", trade.instrument_id)
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1);

    if (candleError || !candles || candles.length === 0) {
      continue;
    }

    const candle = candles[0];
    let exitPrice: number | null = null;
    let exitReason: string | null = null;

    // Check stop loss
    if (trade.side === "long" && candle.low <= trade.stop_loss_price) {
      exitPrice = trade.stop_loss_price;
      exitReason = "stop";
    } else if (trade.side === "short" && candle.high >= trade.stop_loss_price) {
      exitPrice = trade.stop_loss_price;
      exitReason = "stop";
    }

    // Check target
    if (!exitReason) {
      if (trade.side === "long" && candle.high >= trade.target_price) {
        exitPrice = trade.target_price;
        exitReason = "target";
      } else if (trade.side === "short" && candle.low <= trade.target_price) {
        exitPrice = trade.target_price;
        exitReason = "target";
      }
    }

    // Process exit if hit
    if (exitPrice && exitReason) {
      // Apply exit slippage
      const slippageMult = exitReason === "stop" ? 0.0010 : 0.0005; // 0.10% stop, 0.05% target
      const slippageAdjustment = trade.side === "long"
        ? exitPrice * slippageMult // Against you on exit
        : exitPrice * slippageMult;

      const exitPriceWithSlippage = trade.side === "long"
        ? exitPrice + slippageAdjustment
        : exitPrice - slippageAdjustment;

      // Calculate P&L
      const grossPnl = trade.side === "long"
        ? (exitPriceWithSlippage - trade.entry_price) * trade.shares
        : (trade.entry_price - exitPriceWithSlippage) * trade.shares;

      const statutoryCharges = Math.abs(exitPriceWithSlippage * trade.shares * STATUTORY_FEE_PCT);
      const brokerage = BROKERAGE_PER_LEG * 2; // Entry + exit
      const netPnl = grossPnl - statutoryCharges - brokerage;

      const { error: updateError } = await supabase
        .from("bot_paper_trades")
        .update({
          exit_price: exitPriceWithSlippage,
          exit_time: candle.candle_open_at,
          exit_reason: exitReason,
          status: "closed",
          gross_pnl: grossPnl,
          brokerage,
          statutory_charges: statutoryCharges,
          net_pnl: netPnl,
        })
        .eq("id", trade.id);

      if (!updateError) {
        exitsProcessed++;
        const instrument = trade.instruments as { symbol: string; name: string } | null;
        await sendTelegramNotification({
          type: "exit",
          symbol: instrument ? `${instrument.symbol} (${instrument.name})` : "UNKNOWN",
          exitPrice: exitPriceWithSlippage,
          exitReason: exitReason,
          pnl: grossPnl,
          netPnl: netPnl,
          timestamp: candle.candle_open_at,
        });
      }
    }
  }

  return Response.json({ status: "Exit check complete", exits_processed: exitsProcessed });
});
