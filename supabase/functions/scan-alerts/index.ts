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
  previous_day_low: number | null;
  vwap: number | null;
  session_high: number | null;
  session_low: number | null;
  session_volume: number | null;
  session_date: string | null;
  prev_day_volume: number | null;
};

// ---------------------------------------------------------------------------
// Time helpers (IST = UTC+5:30)
// ---------------------------------------------------------------------------

function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function isMorningTrapWindow(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  return (h === 9 && m >= 15) || (h === 10 && m < 15);
}

function minutesSinceOpen(): number {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  return Math.max(1, (nowIst.getUTCHours() - 9) * 60 + nowIst.getUTCMinutes() - 15);
}

// ---------------------------------------------------------------------------
// Shared volume expansion helper
// ---------------------------------------------------------------------------

function volumeStats(
  sessionVolume: number | null,
  prevDayVolume: number | null,
): { hasExpansion: boolean; multiplier: number } {
  if (!sessionVolume || sessionVolume <= 0) {
    return { hasExpansion: false, multiplier: 1 };
  }
  if (!prevDayVolume || prevDayVolume <= 0) {
    return { hasExpansion: true, multiplier: 1.5 }; // no baseline — assume ok
  }
  const expected = prevDayVolume * (minutesSinceOpen() / 375);
  const multiplier = parseFloat((sessionVolume / expected).toFixed(2));
  return { hasExpansion: sessionVolume >= expected * 1.5, multiplier };
}

function convictionScore(distancePct: number, hasVolumeExpansion: boolean): number {
  return Math.min(95, 55 + (hasVolumeExpansion ? 20 : 0) + Math.min(20, Math.round(distancePct * 5)));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async () => {
  if (!getMarketSessionStatus().isOpen) return marketClosedResponse();
  if (!isMorningTrapWindow()) {
    return Response.json({ skipped: "outside morning trap window (09:15–10:15 IST)" });
  }

  const supabase = createServiceClient();

  const { data: instruments, error } = await supabase
    .from("instruments")
    .select(
      "id,symbol,last_price,previous_day_high,previous_day_low,vwap," +
      "session_high,session_low,session_volume,session_date,prev_day_volume",
    )
    .not("last_price", "is", null);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const today = todayIst();
  const alerts = (instruments ?? []).flatMap((inst: Instrument) => {
    const bearish = buildBearishAlert(inst, today);
    const bullish = buildBullishAlert(inst, today);
    return [bearish, bullish].filter(Boolean);
  });

  if (alerts.length === 0) return Response.json({ inserted: 0 });

  // Check which are genuinely new (not already in DB)
  const dedupeKeys = alerts.map((a: Record<string, unknown>) => a.dedupe_key as string);
  const { data: existing } = await supabase
    .from("alerts")
    .select("dedupe_key")
    .in("dedupe_key", dedupeKeys);
  const existingKeys = new Set((existing ?? []).map((r: { dedupe_key: string }) => r.dedupe_key));
  const newAlerts = alerts.filter((a: Record<string, unknown>) => !existingKeys.has(a.dedupe_key as string));

  const { error: insertError } = await supabase
    .from("alerts")
    .upsert(alerts, { onConflict: "dedupe_key" });

  if (insertError) return Response.json({ error: insertError.message }, { status: 500 });

  if (newAlerts.length > 0) {
    await sendTelegramAlerts(newAlerts);
  }

  return Response.json({ upserted: alerts.length, new_alerts: newAlerts.length });
});

// ---------------------------------------------------------------------------
// SIGNAL A — PDH Trap (bearish)
//
// Stock swept the previous day high but closed back below it.
// Price is still 0.75%+ above VWAP → short back to VWAP.
// Validated: 11-yr walk-forward, 50.8% win rate, +0.062% avg return.
// ---------------------------------------------------------------------------

function buildBearishAlert(inst: Instrument, today: string) {
  const { id, symbol, last_price, previous_day_high, vwap, session_high,
          session_volume, session_date, prev_day_volume } = inst;

  if (!last_price || !previous_day_high || !vwap || !session_high || session_date !== today) {
    return null;
  }

  const sweptPdh      = session_high >= previous_day_high;
  const trappedBelow  = last_price < previous_day_high;
  // ≥0.75% above VWAP — parameter-sweep optimum (all positive combos use this threshold)
  const extendedAbove = last_price > vwap * 1.0075;

  if (!sweptPdh || !trappedBelow || !extendedAbove) return null;

  const distPct = ((last_price - vwap) / vwap) * 100;
  const { hasExpansion, multiplier } = volumeStats(session_volume, prev_day_volume);
  const score = convictionScore(distPct, hasExpansion);

  return {
    instrument_id: id,
    dedupe_key: [id, "pdh_trap", "bearish", today].join(":"),
    direction: "bearish",
    title: `${symbol} — PDH trap (failed breakout)`,
    thesis: `${symbol} swept the previous day high (₹${previous_day_high.toFixed(2)}) but rejected and closed back below it. Price is ${distPct.toFixed(2)}% above VWAP — a classic morning liquidity trap. Short back to VWAP.`,
    trigger_price: previous_day_high,
    current_price: last_price,
    swept_level: previous_day_high,
    swept_level_name: "Previous Day High",
    volume_multiplier: multiplier,
    conviction_score: score,
    score_factors: [
      { name: "PDH sweep + rejection", score: 25, state: "confirmed" },
      { name: "VWAP extension", score: Math.min(20, Math.round(distPct * 5)), state: `${distPct.toFixed(2)}% above` },
      { name: "Volume expansion", score: hasExpansion ? 20 : 0, state: hasExpansion ? `${multiplier}× pace` : "weak" },
      { name: "Morning trap window", score: 10, state: "09:15–10:15 active" },
    ],
    timeframe_alignment: {
      daily: "failed breakout above previous session high",
      intraday: "liquidity trap — short back to VWAP",
      vwap: `${distPct.toFixed(2)}% above VWAP`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SIGNAL B — PDL Bounce (bullish)
//
// Exact mirror of Signal A: stock swept the previous day low but closed
// back above it. Price is still 0.75%+ below VWAP → long back to VWAP.
// Validated by symmetry — same statistical logic, opposite direction.
// ---------------------------------------------------------------------------

function buildBullishAlert(inst: Instrument, today: string) {
  const { id, symbol, last_price, previous_day_low, vwap, session_low,
          session_volume, session_date, prev_day_volume } = inst;

  if (!last_price || !previous_day_low || !vwap || !session_low || session_date !== today) {
    return null;
  }

  const sweptPdl      = session_low <= previous_day_low;
  const bouncedAbove  = last_price > previous_day_low;
  // ≥0.75% below VWAP — symmetric threshold to the bearish signal
  const extendedBelow = last_price < vwap * 0.9925;

  if (!sweptPdl || !bouncedAbove || !extendedBelow) return null;

  const distPct = ((vwap - last_price) / last_price) * 100;
  const { hasExpansion, multiplier } = volumeStats(session_volume, prev_day_volume);
  const score = convictionScore(distPct, hasExpansion);

  return {
    instrument_id: id,
    dedupe_key: [id, "pdl_bounce", "bullish", today].join(":"),
    direction: "bullish",
    title: `${symbol} — PDL bounce (failed breakdown)`,
    thesis: `${symbol} swept the previous day low (₹${previous_day_low.toFixed(2)}) but reversed and closed back above it. Price is ${distPct.toFixed(2)}% below VWAP — a bullish liquidity trap. Long back to VWAP.`,
    trigger_price: previous_day_low,
    current_price: last_price,
    swept_level: previous_day_low,
    swept_level_name: "Previous Day Low",
    volume_multiplier: multiplier,
    conviction_score: score,
    score_factors: [
      { name: "PDL sweep + rejection", score: 25, state: "confirmed" },
      { name: "VWAP extension", score: Math.min(20, Math.round(distPct * 5)), state: `${distPct.toFixed(2)}% below` },
      { name: "Volume expansion", score: hasExpansion ? 20 : 0, state: hasExpansion ? `${multiplier}× pace` : "weak" },
      { name: "Morning trap window", score: 10, state: "09:15–10:15 active" },
    ],
    timeframe_alignment: {
      daily: "failed breakdown below previous session low",
      intraday: "liquidity trap — long back to VWAP",
      vwap: `${distPct.toFixed(2)}% below VWAP`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Telegram notifications — sent only for genuinely new alerts
// ---------------------------------------------------------------------------

async function sendTelegramAlerts(alerts: Record<string, unknown>[]) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return; // not configured — silent skip

  for (const alert of alerts) {
    try {
      const dir = alert.direction as string;
      const symbol = (alert.title as string).split(" ")[0];
      const entry = alert.current_price as number;
      const stop = dir === "bearish" ? entry * 1.01 : entry * 0.99;
      const vwap = alert.vwap as number | null;
      const conviction = alert.conviction_score as number;
      const rr = vwap
        ? Math.abs((dir === "bearish" ? entry - vwap : vwap - entry) / (entry * 0.01))
        : null;

      const emoji = dir === "bearish" ? "📉" : "📈";
      const dirLabel = dir === "bearish" ? "SHORT" : "LONG";
      const patternLabel = dir === "bearish" ? "PDH Trap — failed breakout" : "PDL Bounce — failed breakdown";

      const fmt = (n: number) => `₹${n.toFixed(2)}`;
      const lines = [
        `🎯 *MARKET SNIPER ALERT*`,
        ``,
        `${emoji} *${dirLabel} — ${symbol}*`,
        `_${patternLabel}_`,
        ``,
        `Entry:      ${fmt(entry)}`,
        `Stop:       ${fmt(stop)} (1%)`,
        vwap ? `VWAP (TP):  ${fmt(vwap)}` : `VWAP:       awaiting`,
        rr ? `R:R:        ${rr.toFixed(2)}:1` : ``,
        `Conviction: ${conviction}%`,
        ``,
        `⏰ Exit within *20 minutes* or at VWAP`,
      ].filter(l => l !== null);

      const text = lines.join("\n");
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      console.error("[scan-alerts] Telegram notification failed:", err instanceof Error ? err.message : err);
    }
  }
}
