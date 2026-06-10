// DB-backed helpers for the selective engine, shared by scan-alerts and
// orb-scanner. Pure math lives in trade-math.ts; this file owns the queries.

import type { createServiceClient } from "./supabase.ts";
import {
  atrFrom1mCandles,
  stopTargetFromAtr,
  type Candle1m,
  type TradeSide,
} from "./trade-math.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type NiftyRegime = {
  spot: number | null;
  orHigh: number | null;
  orLow: number | null;
};

const SPOT_STALE_MS = 10 * 60 * 1000;

// NIFTY spot samples come from bot_premium_decay_points.underlying_ltp —
// an options-dashboard table we READ ONLY, never modify. The computed opening
// range is cached on bot_settings so we hit the big table once per day.
export async function getNiftyRegime(
  supabase: ServiceClient,
  todayIst: string,
): Promise<NiftyRegime> {
  const { data: settings } = await supabase
    .from("bot_settings")
    .select("nifty_or_high,nifty_or_low,nifty_or_date")
    .eq("id", 1)
    .maybeSingle();

  let orHigh: number | null = settings?.nifty_or_high ?? null;
  let orLow: number | null = settings?.nifty_or_low ?? null;

  if (settings?.nifty_or_date !== todayIst) {
    orHigh = null;
    orLow = null;
    // 9:15–9:30 IST = 03:45–04:00 UTC
    const { data: samples } = await supabase
      .from("bot_premium_decay_points")
      .select("underlying_ltp")
      .gte("sampled_at", `${todayIst}T03:45:00Z`)
      .lt("sampled_at", `${todayIst}T04:00:00Z`)
      .not("underlying_ltp", "is", null);

    const ltps = (samples ?? [])
      .map((row: { underlying_ltp: number | null }) => row.underlying_ltp)
      .filter((v): v is number => typeof v === "number" && v > 0);

    if (ltps.length > 0) {
      orHigh = Math.max(...ltps);
      orLow = Math.min(...ltps);
      await supabase
        .from("bot_settings")
        .update({
          nifty_or_high: orHigh,
          nifty_or_low: orLow,
          nifty_or_date: todayIst,
        })
        .eq("id", 1);
    }
  }

  const { data: latest } = await supabase
    .from("bot_premium_decay_points")
    .select("underlying_ltp,sampled_at")
    .not("underlying_ltp", "is", null)
    .order("sampled_at", { ascending: false })
    .limit(1);

  let spot: number | null = null;
  if (latest && latest.length > 0) {
    const age = Date.now() - new Date(latest[0].sampled_at).getTime();
    if (age <= SPOT_STALE_MS) spot = latest[0].underlying_ltp;
  }

  return { spot, orHigh, orLow };
}

// ATR-based stop/target for an instrument from its recent 1-min candles.
// Falls back to a 0.75% stop inside stopTargetFromAtr when data is thin.
export async function fetchAtrStops(
  supabase: ServiceClient,
  instrumentId: string,
  side: TradeSide,
  entryPrice: number,
): Promise<{ stopLossPrice: number; targetPrice: number }> {
  const { data: candles } = await supabase
    .from("bot_candles")
    .select("high,low,close")
    .eq("instrument_id", instrumentId)
    .eq("timeframe", "1m")
    .order("candle_open_at", { ascending: false })
    .limit(80);

  const oldestFirst = ((candles ?? []) as Candle1m[]).slice().reverse();
  const atr = atrFrom1mCandles(oldestFirst);
  return stopTargetFromAtr(side, entryPrice, atr);
}
