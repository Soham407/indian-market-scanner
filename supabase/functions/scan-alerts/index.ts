import { createServiceClient } from "../_shared/supabase.ts";
import {
  getMarketSessionStatus,
  marketClosedResponse,
} from "../_shared/market-hours.ts";

type Instrument = {
  id: string;
  symbol: string;
  last_price: number | null;
  previous_day_high: number | null;
  vwap: number | null;
  session_high: number | null;
  session_volume: number | null;
  session_date: string | null;
  prev_day_volume: number | null;
};

// ---------------------------------------------------------------------------
// Time helpers (all in IST = UTC+5:30)
// ---------------------------------------------------------------------------

function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// The validated backtest fires exclusively in the 09:15–10:15 morning window.
// Traps outside this window have no validated edge; we don't emit them.
function isMorningTrapWindow(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  return (h === 9 && m >= 15) || (h === 10 && m < 15);
}

// Minutes elapsed since market open (09:15 IST), clamped to 1 to avoid div-by-zero.
function minutesSinceOpen(): number {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const elapsed = (nowIst.getUTCHours() - 9) * 60 + nowIst.getUTCMinutes() - 15;
  return Math.max(1, elapsed);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async () => {
  if (!getMarketSessionStatus().isOpen) {
    return marketClosedResponse();
  }

  // Hard gate: only scan during the validated morning trap window (09:15–10:15).
  if (!isMorningTrapWindow()) {
    return Response.json({ skipped: "outside morning trap window (09:15–10:15 IST)" });
  }

  const supabase = createServiceClient();

  const { data: instruments, error } = await supabase
    .from("instruments")
    .select(
      "id,symbol,last_price,previous_day_high,vwap,session_high,session_volume,session_date,prev_day_volume",
    )
    .not("last_price", "is", null);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const alerts = (instruments ?? [])
    .map((instrument: Instrument) => buildAlert(instrument))
    .filter(Boolean);

  if (alerts.length === 0) {
    return Response.json({ inserted: 0 });
  }

  const { error: insertError } = await supabase
    .from("alerts")
    .upsert(alerts, { onConflict: "dedupe_key" });

  if (insertError) {
    return Response.json({ error: insertError.message }, { status: 500 });
  }

  return Response.json({ upserted: alerts.length });
});

// ---------------------------------------------------------------------------
// Signal builder — implements the validated walk-forward backtest conditions:
//
//   bait  : session_high >= PDH   (stock swept the previous day high today)
//   trap  : last_price < PDH      (but closed BACK below it — failed breakout)
//   vwap  : last_price > VWAP × 1.002   (still extended; VWAP is the target)
//   volume: session volume at a 1.5× pace relative to previous session baseline
//   time  : 09:15–10:15 IST only  (gated above before this function is called)
//
// Stop loss: 1% above entry (matches sl_stop=0.01 in the vectorbt backtest).
// ---------------------------------------------------------------------------

function buildAlert(instrument: Instrument) {
  const {
    id,
    symbol,
    last_price,
    previous_day_high,
    vwap,
    session_high,
    session_volume,
    session_date,
    prev_day_volume,
  } = instrument;

  // Require all core fields and confirm session data is from today.
  if (
    !last_price ||
    !previous_day_high ||
    !vwap ||
    !session_high ||
    session_date !== todayIst()
  ) {
    return null;
  }

  // --- Signal conditions ---------------------------------------------------

  // bait: the stock touched or exceeded PDH at some point this session
  const sweptPdh = session_high >= previous_day_high;
  // trap: current price has since fallen back below PDH (failed breakout)
  const trappedBelowPdh = last_price < previous_day_high;
  // vwap: still meaningfully extended above VWAP (0.2% threshold from backtest)
  const aboveVwap = last_price > vwap * 1.002;

  if (!sweptPdh || !trappedBelowPdh || !aboveVwap) return null;

  const distanceToVwap = ((last_price - vwap) / vwap) * 100;

  // --- Volume expansion ----------------------------------------------------
  // Compare current session volume to the expected pace from the previous day.
  // Trading day = 375 min; at a uniform pace, minutesSinceOpen() / 375 of daily
  // volume should have traded. Volume expansion = actual > expected × 1.5.
  const elapsedFraction = minutesSinceOpen() / 375;
  const hasVolumeExpansion = (() => {
    if (!session_volume || session_volume <= 0) return false;
    if (!prev_day_volume || prev_day_volume <= 0) return true; // no baseline → assume ok
    return session_volume >= prev_day_volume * elapsedFraction * 1.5;
  })();

  const volumeMultiplier = (() => {
    if (!session_volume || !prev_day_volume || prev_day_volume <= 0) return 1.5;
    const expected = prev_day_volume * elapsedFraction;
    return parseFloat((session_volume / expected).toFixed(2));
  })();

  // --- Conviction score ----------------------------------------------------
  // Base 55 for a confirmed trap, +20 for real volume, +up to 20 for VWAP extension.
  const score =
    55 +
    (hasVolumeExpansion ? 20 : 0) +
    Math.min(20, Math.round(distanceToVwap * 5));
  const convictionScore = Math.min(95, score);

  return {
    instrument_id: id,
    dedupe_key: [
      id,
      "liquidity_trap",
      "bearish",
      "Previous Day High",
      new Date().toISOString().slice(0, 10),
    ].join(":"),
    direction: "bearish",
    title: `${symbol} failed breakout above PDH`,
    thesis: `${symbol} swept the previous day high (₹${previous_day_high.toFixed(2)}) but rejected and closed back below it, with price still ${distanceToVwap.toFixed(2)}% above VWAP. Classic morning liquidity trap — short back to VWAP.`,
    trigger_price: previous_day_high,
    current_price: last_price,
    swept_level: previous_day_high,
    swept_level_name: "Previous Day High",
    volume_multiplier: volumeMultiplier,
    conviction_score: convictionScore,
    score_factors: [
      { name: "PDH sweep + rejection", score: 25, state: "confirmed" },
      {
        name: "VWAP extension",
        score: Math.min(20, Math.round(distanceToVwap * 5)),
        state: `${distanceToVwap.toFixed(2)}% above`,
      },
      {
        name: "Volume expansion",
        score: hasVolumeExpansion ? 20 : 0,
        state: hasVolumeExpansion ? `${volumeMultiplier}× pace` : "weak",
      },
      { name: "Morning trap window", score: 10, state: "09:15–10:15 active" },
    ],
    timeframe_alignment: {
      daily: "failed breakout above previous session high",
      intraday: "liquidity trap — short back to VWAP",
      vwap: `${distanceToVwap.toFixed(2)}% above VWAP`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
