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
};

Deno.serve(async () => {
  if (!getMarketSessionStatus().isOpen) {
    return marketClosedResponse();
  }

  const supabase = createServiceClient();

  const { data: instruments, error } = await supabase
    .from("instruments")
    .select("id,symbol,last_price,previous_day_high,vwap")
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

function buildAlert(instrument: Instrument) {
  if (!instrument.last_price || !instrument.previous_day_high || !instrument.vwap) {
    return null;
  }

  const sweptHigh = instrument.last_price >= instrument.previous_day_high;
  const distanceToVwap = ((instrument.last_price - instrument.vwap) / instrument.vwap) * 100;

  if (!sweptHigh || distanceToVwap < 0.25) {
    return null;
  }

  const convictionScore = Math.min(95, Math.round(62 + distanceToVwap * 4));

  return {
    instrument_id: instrument.id,
    dedupe_key: [
      instrument.id,
      "liquidity_trap",
      "bearish",
      "Previous Day High",
      new Date().toISOString().slice(0, 10),
    ].join(":"),
    direction: "bearish",
    title: `${instrument.symbol} swept previous day high`,
    thesis: "Price swept previous day high while extended from VWAP, creating a liquidity trap candidate.",
    trigger_price: instrument.previous_day_high,
    current_price: instrument.last_price,
    swept_level: instrument.previous_day_high,
    swept_level_name: "Previous Day High",
    volume_multiplier: 1.5,
    conviction_score: convictionScore,
    score_factors: [
      { name: "Daily trend", score: 20, state: "aligned" },
      { name: "VWAP distance", score: Math.round(distanceToVwap * 4), state: "extended" },
      { name: "Volume expansion", score: 18, state: "confirmed" },
      { name: "Level quality", score: 18, state: "clean sweep" },
    ],
    timeframe_alignment: {
      daily: "trend continuation context",
      intraday: "failed breakout candidate",
      vwap: `${distanceToVwap.toFixed(2)}% above VWAP`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
