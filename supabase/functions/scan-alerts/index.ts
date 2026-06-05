import { createServiceClient } from "../_shared/supabase.ts";
import {
  getMarketSessionStatus,
  marketClosedResponse,
} from "../_shared/market-hours.ts";
import { ema, rsi, sma } from "../_shared/indicators.ts";

type Instrument = {
  id: string;
  symbol: string;
  last_price: number | null;
  angel_one_token: string | null;
  previous_day_high: number | null;
  previous_day_low: number | null;
  vwap: number | null;
  session_high: number | null;
  session_low: number | null;
  session_volume: number | null;
  session_date: string | null;
  prev_day_volume: number | null;
  or_high: number | null;
  or_low: number | null;
  or_date: string | null;
};

type AlertCandidate = {
  instrument_id: string;
  dedupe_key: string;
  direction: "bullish" | "bearish";
  title: string;
  trigger_price: number;
  current_price: number;
  take_profit_price?: number | null;
  swept_level: number;
  swept_level_name: string;
  volume_multiplier: number;
  conviction_score: number;
  score_factors: unknown[];
  timeframe_alignment: Record<string, unknown>;
  expires_at: string;
};

type StrategyLookup = {
  id: string;
  name: string;
};

type DailyCandle = [string, number, number, number, number, number];
type AngelAuth = { apiKey: string; jwtToken: string };

const OR_BREAKOUT_WHITELIST = new Set([
  "INDUSINDBK",
  "RELIANCE",
  "TATASTEEL",
  "TITAN",
  "WIPRO",
]);

// ---------------------------------------------------------------------------
// Time helpers (IST = UTC+5:30)
// ---------------------------------------------------------------------------

function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function tradingDateForScan(): string {
  const nowMs = Date.now() + 5.5 * 3600 * 1000;
  const now = new Date(nowMs);
  const dow = now.getUTCDay();
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  const marketCloseIstMin = 930; // 15:30 IST
  if (dow >= 1 && dow <= 5 && hm >= marketCloseIstMin) {
    return now.toISOString().slice(0, 10);
  }
  const back = dow === 0 ? 2 : dow === 1 ? 3 : 1;
  return new Date(nowMs - back * 86400 * 1000).toISOString().slice(0, 10);
}

function historicalFromDate(): string {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 - 120 * 86400 * 1000);
  return d.toISOString().slice(0, 10) + " 09:00";
}

async function generateTotp(secret: string): Promise<string> {
  const stripped = secret.replace(/[-\s]/g, "");
  const isHex = /^[0-9a-fA-F]+$/.test(stripped) && stripped.length % 2 === 0;
  let keyBytes: Uint8Array;
  if (isHex) {
    keyBytes = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < keyBytes.length; i++) {
      keyBytes[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = stripped.toUpperCase().replace(/=/g, "");
    let bits = "";
    for (const ch of cleaned) {
      const v = alphabet.indexOf(ch);
      bits += (v === -1 ? 0 : v).toString(2).padStart(5, "0");
    }
    keyBytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < keyBytes.length; i++) {
      keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const keyData = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyData).set(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[19] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

function angelHeaders(apiKey: string, jwtToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "1.1.1.1",
    "X-MACAddress": "00-00-00-00-00-00",
    "X-PrivateKey": apiKey,
  };
  if (jwtToken) h["Authorization"] = `Bearer ${jwtToken}`;
  return h;
}

async function authenticateAngelOne(): Promise<AngelAuth> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");
  if (!apiKey || !secretKey || !clientId || !pin) {
    throw new Error("Missing Angel One secrets");
  }
  const totp = await generateTotp(secretKey);
  const resp = await fetch("https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword", {
    method: "POST",
    headers: angelHeaders(apiKey),
    body: JSON.stringify({ clientcode: clientId, password: pin, totp }),
  });
  const data = await resp.json();
  if (!data?.status || !data?.data?.jwtToken) {
    throw new Error(`Angel One login failed: ${data?.message ?? JSON.stringify(data)}`);
  }
  return { apiKey, jwtToken: data.data.jwtToken as string };
}

async function fetchDailyCandles(
  apiKey: string,
  jwtToken: string,
  token: string,
): Promise<DailyCandle[]> {
  const todate = tradingDateForScan() + " 15:30";
  const resp = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData", {
    method: "POST",
    headers: angelHeaders(apiKey, jwtToken),
    body: JSON.stringify({
      exchange: "NSE",
      symboltoken: token,
      interval: "ONE_DAY",
      fromdate: historicalFromDate(),
      todate,
    }),
  });
  const data = await resp.json();
  return (data?.data ?? []) as DailyCandle[];
}

function dailyAtr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  return sma(trs.slice(-period), period);
}

async function passesOrBreakoutDailyGate(
  inst: Instrument,
  auth: AngelAuth,
): Promise<boolean> {
  if (!OR_BREAKOUT_WHITELIST.has(inst.symbol)) return false;
  if (!inst.angel_one_token) return false;

  const candles = await fetchDailyCandles(auth.apiKey, auth.jwtToken, inst.angel_one_token);
  if (candles.length < 21) return false;

  // Use the most recent fully completed daily bar as the regime anchor.
  // The last returned bar is the current trading day, so we only use its open
  // for the gap check and keep all indicator inputs on prior completed bars.
  const latestBar = candles[candles.length - 1];
  const priorBar = candles[candles.length - 2];
  const history = candles.slice(0, -1);
  const highs = history.map((c) => c[2]);
  const lows = history.map((c) => c[3]);
  const closes = history.map((c) => c[4]);
  const regimeClose = closes[closes.length - 1];
  const regimeOpen = latestBar[1];
  const prevClose = priorBar[4];
  const ema5Val = ema(closes, 5);
  const rsiVal = rsi(closes, 14);
  const atrVal = dailyAtr(highs, lows, closes, 14);
  if ([regimeClose, regimeOpen, prevClose, ema5Val, rsiVal, atrVal].some((v) => !Number.isFinite(v))) {
    return false;
  }

  const gapPct = (regimeOpen - prevClose) / prevClose;
  return (
    regimeClose > ema5Val &&
    rsiVal > 55 &&
    gapPct <= -0.005 &&
    (atrVal / regimeClose) > 0.02
  );
}

function isMorningTrapWindow(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  return (h === 9 && m >= 15) || (h === 10 && m < 15);
}

// 10:15–13:30 IST — opening range is closed, OR trap signal window.
function isOrTrapWindow(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  return (h === 10 && m >= 15) || h === 11 || h === 12 || (h === 13 && m <= 30);
}

// 10:15–14:30 IST — momentum breakout window (wider than trap window).
function isOrBreakoutWindow(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  return (h === 10 && m >= 15) || h === 11 || h === 12 || h === 13 || (h === 14 && m <= 30);
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

function patternFromDedupeKey(dedupeKey: string): string | null {
  const [, pattern] = dedupeKey.split(":");
  return pattern || null;
}

function toBotSignal(
  alert: AlertCandidate,
  strategyId: string,
  nowIso: string,
) {
  const side = alert.direction === "bearish" ? "short" : "long";
  const triggerPrice = alert.current_price;
  const fallbackStop = side === "short" ? triggerPrice * 1.01 : triggerPrice * 0.99;
  const fallbackTarget = side === "short" ? triggerPrice * 0.985 : triggerPrice * 1.015;
  const rawTarget = alert.take_profit_price;
  const targetPrice = rawTarget && (
      (side === "short" && rawTarget < triggerPrice) ||
      (side === "long" && rawTarget > triggerPrice)
    )
    ? rawTarget
    : fallbackTarget;

  return {
    strategy_id: strategyId,
    source: patternFromDedupeKey(alert.dedupe_key) ?? "market_sniper_alert",
    instrument_id: alert.instrument_id,
    side,
    signal_time: nowIso,
    trigger_price: Number(triggerPrice.toFixed(4)),
    stop_loss_price: Number(fallbackStop.toFixed(4)),
    target_price: Number(targetPrice.toFixed(4)),
    timeframe: "1m",
    metadata: {
      alert_dedupe_key: alert.dedupe_key,
      alert_title: alert.title,
      swept_level: alert.swept_level,
      swept_level_name: alert.swept_level_name,
      volume_multiplier: alert.volume_multiplier,
      timeframe_alignment: alert.timeframe_alignment,
      source_system: "market_sniper",
    },
  };
}

async function enqueueBotSignals(
  supabase: ReturnType<typeof createServiceClient>,
  alerts: AlertCandidate[],
): Promise<{ queued: number; skipped: number; error?: string }> {
  if (alerts.length === 0) return { queued: 0, skipped: 0 };

  const patterns = [...new Set(alerts.map((alert) => patternFromDedupeKey(alert.dedupe_key)).filter((pattern): pattern is string => !!pattern))];
  const { data: strategies, error: strategyError } = await supabase
    .from("bot_strategies")
    .select("id,name")
    .in("name", patterns)
    .eq("enabled", true)
    .neq("lifecycle_status", "disabled");

  if (strategyError) return { queued: 0, skipped: alerts.length, error: strategyError.message };

  const strategyByName = new Map((strategies ?? []).map((strategy: StrategyLookup) => [strategy.name, strategy.id]));
  const nowIso = new Date().toISOString();
  const signals = alerts.flatMap((alert) => {
    const pattern = patternFromDedupeKey(alert.dedupe_key);
    const strategyId = pattern ? strategyByName.get(pattern) : undefined;
    return strategyId ? [toBotSignal(alert, strategyId, nowIso)] : [];
  });

  if (signals.length === 0) return { queued: 0, skipped: alerts.length };

  const signalKeys = signals
    .map((signal) => signal.metadata?.alert_dedupe_key)
    .filter((key): key is string => typeof key === "string");

  const { data: existingSignals, error: existingSignalsError } = await supabase
    .from("bot_trade_signals")
    .select("metadata")
    .in("metadata->>alert_dedupe_key", signalKeys)
    .in("status", ["pending", "shadow_tracked", "accepted"]);
  if (existingSignalsError) {
    return { queued: 0, skipped: alerts.length, error: existingSignalsError.message };
  }

  const existingSignalKeys = new Set(
    (existingSignals ?? [])
      .map((row: { metadata: Record<string, unknown> }) => row.metadata?.alert_dedupe_key)
      .filter((key): key is string => typeof key === "string"),
  );
  const missingSignals = signals.filter((signal) =>
    !existingSignalKeys.has(signal.metadata.alert_dedupe_key as string)
  );

  if (missingSignals.length === 0) return { queued: 0, skipped: alerts.length };

  let queued = 0;
  for (const signal of missingSignals) {
    const { error } = await supabase.from("bot_trade_signals").insert(signal);
    if (error) {
      const isDuplicateRace = "code" in error && error.code === "23505";
      if (isDuplicateRace) continue;
      return { queued, skipped: alerts.length - queued, error: error.message };
    }
    queued++;
  }

  return { queued, skipped: alerts.length - queued };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async () => {
  if (!getMarketSessionStatus().isOpen) return marketClosedResponse();

  const inMorning = isMorningTrapWindow();
  const inOrWindow = isOrTrapWindow();
  const inBreakoutWindow = isOrBreakoutWindow();

  if (!inMorning && !inOrWindow && !inBreakoutWindow) {
    return Response.json({ skipped: "outside all active signal windows" });
  }

  const supabase = createServiceClient();

  const { data: instruments, error } = await supabase
    .from("instruments")
    .select(
      "id,symbol,last_price,angel_one_token,previous_day_high,previous_day_low,vwap," +
      "session_high,session_low,session_volume,session_date,prev_day_volume," +
      "or_high,or_low,or_date",
    )
    .not("last_price", "is", null);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const today = todayIst();
  const hasOrBreakoutCandidate = (instruments ?? []).some((rawInst) => {
    const inst = rawInst as unknown as Instrument;
    return OR_BREAKOUT_WHITELIST.has(inst.symbol) && !!inst.angel_one_token;
  });
  const angelAuthPromise: Promise<AngelAuth | null> = hasOrBreakoutCandidate
    ? authenticateAngelOne().catch((err) => {
        console.error("[scan-alerts] Angel One auth failed for OR breakout gate:", err);
        return null;
      })
    : Promise.resolve(null);
  const alerts = (await Promise.all((instruments ?? []).map(async (rawInst) => {
    const inst = rawInst as unknown as Instrument;
    const bearish = buildBearishAlert(inst, today);
    const bullish = buildBullishAlert(inst, today);
    const orBearish = buildOrTrapBearish(inst, today);
    const orBullish = buildOrTrapBullish(inst, today);
    const angelAuth = await angelAuthPromise;
    const orBreakBullish = angelAuth ? await buildOrBreakoutBullish(inst, today, angelAuth) : null;
    const orBreakBearish = angelAuth ? await buildOrBreakoutBearish(inst, today, angelAuth) : null;
    return [bearish, bullish, orBearish, orBullish, orBreakBullish, orBreakBearish].filter(Boolean);
  }))).flat() as AlertCandidate[];

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

  const botQueue = await enqueueBotSignals(supabase, alerts as AlertCandidate[]);

  return Response.json({
    upserted: alerts.length,
    new_alerts: newAlerts.length,
    bot_signals_queued: botQueue.queued,
    bot_signals_skipped: botQueue.skipped,
    bot_signal_error: botQueue.error ?? null,
  });
});

// ---------------------------------------------------------------------------
// SIGNAL A — PDH Trap (bearish)
//
// Stock swept the previous day high but closed back below it.
// Price is still 0.75%+ above VWAP → short back to VWAP.
// Validated: 11-yr walk-forward, 50.8% win rate, +0.062% avg return.
// ---------------------------------------------------------------------------

function buildBearishAlert(inst: Instrument, today: string) {
  if (!isMorningTrapWindow()) return null;

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
    take_profit_price: vwap,
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
  if (!isMorningTrapWindow()) return null;

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
    take_profit_price: vwap,
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
// SIGNAL C — Opening Range Trap (bearish)
//
// After the first-hour OR is set (09:15–10:15), if price breaks above the OR
// high and then reverses back below it, it's a failed breakout. Short to VWAP.
// Same mechanical thesis as the PDH trap — different reference level.
// ---------------------------------------------------------------------------

function buildOrTrapBearish(inst: Instrument, today: string) {
  if (!isOrTrapWindow()) return null;

  const { id, symbol, last_price, or_high, or_date, vwap,
          session_high, session_volume, prev_day_volume } = inst;

  if (!last_price || !or_high || or_date !== today || !vwap || !session_high) {
    return null;
  }

  // A new high was made above the OR high after 10:15, then reversed below it.
  const brokeOut     = session_high > or_high;
  const trappedBelow = last_price < or_high;
  // Same VWAP extension threshold as the morning trap.
  const extendedAbove = last_price > vwap * 1.0075;

  if (!brokeOut || !trappedBelow || !extendedAbove) return null;

  const distPct = ((last_price - vwap) / vwap) * 100;
  const { hasExpansion, multiplier } = volumeStats(session_volume, prev_day_volume);
  const score = convictionScore(distPct, hasExpansion);

  return {
    instrument_id: id,
    dedupe_key: [id, "or_trap", "bearish", today].join(":"),
    direction: "bearish",
    title: `${symbol} — OR trap (failed range breakout)`,
    thesis: `${symbol} broke above the opening range high (₹${or_high.toFixed(2)}) but failed to hold and reversed below it. Price is ${distPct.toFixed(2)}% above VWAP — a classic failed breakout trap. Short back to VWAP.`,
    trigger_price: or_high,
    current_price: last_price,
    take_profit_price: vwap,
    swept_level: or_high,
    swept_level_name: "Opening Range High",
    volume_multiplier: multiplier,
    conviction_score: score,
    score_factors: [
      { name: "OR breakout + rejection", score: 25, state: "confirmed" },
      { name: "VWAP extension", score: Math.min(20, Math.round(distPct * 5)), state: `${distPct.toFixed(2)}% above` },
      { name: "Volume expansion", score: hasExpansion ? 20 : 0, state: hasExpansion ? `${multiplier}× pace` : "weak" },
      { name: "OR trap window", score: 10, state: "10:15–13:30 active" },
    ],
    timeframe_alignment: {
      daily: "failed breakout above opening range high",
      intraday: "OR trap — short back to VWAP",
      vwap: `${distPct.toFixed(2)}% above VWAP`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SIGNAL D — Opening Range Trap (bullish)
//
// Mirror of Signal C: price swept below the OR low then bounced back above it.
// Long back to VWAP.
// ---------------------------------------------------------------------------

function buildOrTrapBullish(inst: Instrument, today: string) {
  if (!isOrTrapWindow()) return null;

  const { id, symbol, last_price, or_low, or_date, vwap,
          session_low, session_volume, prev_day_volume } = inst;

  if (!last_price || !or_low || or_date !== today || !vwap || !session_low) {
    return null;
  }

  // A new low was made below the OR low after 10:15, then reversed above it.
  const brokeDown   = session_low < or_low;
  const bouncedAbove = last_price > or_low;
  // Same VWAP extension threshold as the morning trap.
  const extendedBelow = last_price < vwap * 0.9925;

  if (!brokeDown || !bouncedAbove || !extendedBelow) return null;

  const distPct = ((vwap - last_price) / last_price) * 100;
  const { hasExpansion, multiplier } = volumeStats(session_volume, prev_day_volume);
  const score = convictionScore(distPct, hasExpansion);

  return {
    instrument_id: id,
    dedupe_key: [id, "or_trap", "bullish", today].join(":"),
    direction: "bullish",
    title: `${symbol} — OR trap (failed range breakdown)`,
    thesis: `${symbol} broke below the opening range low (₹${or_low.toFixed(2)}) but reversed and closed back above it. Price is ${distPct.toFixed(2)}% below VWAP — a failed breakdown trap. Long back to VWAP.`,
    trigger_price: or_low,
    current_price: last_price,
    take_profit_price: vwap,
    swept_level: or_low,
    swept_level_name: "Opening Range Low",
    volume_multiplier: multiplier,
    conviction_score: score,
    score_factors: [
      { name: "OR breakdown + rejection", score: 25, state: "confirmed" },
      { name: "VWAP extension", score: Math.min(20, Math.round(distPct * 5)), state: `${distPct.toFixed(2)}% below` },
      { name: "Volume expansion", score: hasExpansion ? 20 : 0, state: hasExpansion ? `${multiplier}× pace` : "weak" },
      { name: "OR trap window", score: 10, state: "10:15–13:30 active" },
    ],
    timeframe_alignment: {
      daily: "failed breakdown below opening range low",
      intraday: "OR trap — long back to VWAP",
      vwap: `${distPct.toFixed(2)}% below VWAP`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SIGNAL E — Opening Range Breakout (bullish)
//
// Price broke above the OR high and is holding the breakout — buy the momentum.
// Opposite of Signal C (OR Trap): here the breakout is CONFIRMED, not failed.
// Window extends to 14:30 IST to catch afternoon momentum sessions.
// ---------------------------------------------------------------------------

async function buildOrBreakoutBullish(inst: Instrument, today: string, auth: AngelAuth) {
  if (!isOrBreakoutWindow()) return null;
  if (!OR_BREAKOUT_WHITELIST.has(inst.symbol)) return null;
  if (!(await passesOrBreakoutDailyGate(inst, auth))) return null;

  const { id, symbol, last_price, or_high, or_low, or_date, vwap,
          session_high, session_volume, prev_day_volume } = inst;

  if (!last_price || !or_high || !or_low || or_date !== today || !vwap || !session_high) {
    return null;
  }

  // Price broke above OR high and is still holding above it — confirmed breakout.
  const confirmedBreak = last_price > or_high;
  // Price must be above VWAP (bullish momentum, not a wick above OR then back below VWAP).
  const aboveVwap = last_price > vwap;
  // Price hasn't pulled back more than 0.5% from the session high — still near highs.
  const holdingBreak = last_price >= session_high * 0.995;

  if (!confirmedBreak || !aboveVwap || !holdingBreak) return null;

  const distPct = ((last_price - or_high) / or_high) * 100;
  // Only fire within 2% of the OR high — beyond that the optimal entry has passed.
  if (distPct >= 2.0) return null;

  const { hasExpansion, multiplier } = volumeStats(session_volume, prev_day_volume);
  // Fresh breaks (low distPct) score highest — inverted so max bonus at the OR high.
  const distBonus = Math.max(0, Math.round(20 * (1 - distPct / 2)));
  const score = Math.min(95, (hasExpansion ? 65 : 45) + distBonus);

  // Measured move target: OR range projected above the OR high.
  const takeProfitPrice = or_high + (or_high - or_low);

  return {
    instrument_id: id,
    dedupe_key: [id, "or_breakout", "bullish", today].join(":"),
    direction: "bullish",
    title: `${symbol} — OR breakout (momentum buy)`,
    thesis: `${symbol} broke above the opening range high (₹${or_high.toFixed(2)}) and is holding the breakout ${distPct.toFixed(2)}% above OR. Price is above VWAP — momentum is confirmed. Target: ₹${takeProfitPrice.toFixed(2)} (measured move).`,
    trigger_price: or_high,
    current_price: last_price,
    take_profit_price: takeProfitPrice,
    swept_level: or_high,
    swept_level_name: "Opening Range High",
    volume_multiplier: multiplier,
    conviction_score: score,
    score_factors: [
      { name: "OR breakout confirmed", score: 25, state: `${distPct.toFixed(2)}% above OR` },
      { name: "Holding near session high", score: 10, state: "within 0.5%" },
      { name: "Above VWAP", score: 10, state: "bullish bias" },
      { name: "Volume expansion", score: hasExpansion ? 20 : 0, state: hasExpansion ? `${multiplier}× pace` : "weak — caution" },
    ],
    timeframe_alignment: {
      daily: "confirmed breakout above opening range high",
      intraday: "momentum buy — trailing stop below OR high",
      target: `₹${takeProfitPrice.toFixed(2)} measured move`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SIGNAL F — Opening Range Breakdown (bearish momentum)
//
// Mirror of Signal E: price broke below the OR low and is holding below it.
// Short the momentum — price likely heading lower.
// ---------------------------------------------------------------------------

async function buildOrBreakoutBearish(inst: Instrument, today: string, auth: AngelAuth) {
  if (!isOrBreakoutWindow()) return null;
  if (!OR_BREAKOUT_WHITELIST.has(inst.symbol)) return null;
  if (!(await passesOrBreakoutDailyGate(inst, auth))) return null;

  const { id, symbol, last_price, or_low, or_high, or_date, vwap,
          session_low, session_volume, prev_day_volume } = inst;

  if (!last_price || !or_low || !or_high || or_date !== today || !vwap || !session_low) {
    return null;
  }

  const confirmedBreak = last_price < or_low;
  const belowVwap = last_price < vwap;
  const holdingBreak = last_price <= session_low * 1.005;

  if (!confirmedBreak || !belowVwap || !holdingBreak) return null;

  const distPct = ((or_low - last_price) / or_low) * 100;
  // Only fire within 2% of the OR low — beyond that the optimal entry has passed.
  if (distPct >= 2.0) return null;

  const { hasExpansion, multiplier } = volumeStats(session_volume, prev_day_volume);
  // Fresh breaks (low distPct) score highest — inverted so max bonus at the OR low.
  const distBonus = Math.max(0, Math.round(20 * (1 - distPct / 2)));
  const score = Math.min(95, (hasExpansion ? 65 : 45) + distBonus);

  // Measured move target: OR range projected below the OR low.
  const takeProfitPrice = or_low - (or_high - or_low);

  return {
    instrument_id: id,
    dedupe_key: [id, "or_breakout", "bearish", today].join(":"),
    direction: "bearish",
    title: `${symbol} — OR breakdown (momentum short)`,
    thesis: `${symbol} broke below the opening range low (₹${or_low.toFixed(2)}) and is holding the breakdown ${distPct.toFixed(2)}% below OR. Price is below VWAP — momentum is confirmed bearish. Target: ₹${takeProfitPrice.toFixed(2)} (measured move).`,
    trigger_price: or_low,
    current_price: last_price,
    take_profit_price: takeProfitPrice,
    swept_level: or_low,
    swept_level_name: "Opening Range Low",
    volume_multiplier: multiplier,
    conviction_score: score,
    score_factors: [
      { name: "OR breakdown confirmed", score: 25, state: `${distPct.toFixed(2)}% below OR` },
      { name: "Holding near session low", score: 10, state: "within 0.5%" },
      { name: "Below VWAP", score: 10, state: "bearish bias" },
      { name: "Volume expansion", score: hasExpansion ? 20 : 0, state: hasExpansion ? `${multiplier}× pace` : "weak — caution" },
    ],
    timeframe_alignment: {
      daily: "confirmed breakdown below opening range low",
      intraday: "momentum short — trailing stop above OR low",
      target: `₹${takeProfitPrice.toFixed(2)} measured move`,
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
      const tp = alert.take_profit_price as number | null;
      const conviction = alert.conviction_score as number;
      const rr = tp
        ? Math.abs((dir === "bearish" ? entry - tp : tp - entry) / (entry * 0.01))
        : null;

      const emoji = dir === "bearish" ? "📉" : "📈";
      const dirLabel = dir === "bearish" ? "SHORT" : "LONG";
      const titleStr = alert.title as string;

      const fmt = (n: number) => `₹${n.toFixed(2)}`;
      const lines = [
        `🎯 *MARKET SNIPER ALERT*`,
        ``,
        `${emoji} *${dirLabel} — ${symbol}*`,
        `_${titleStr}_`,
        ``,
        `Entry:      ${fmt(entry)}`,
        `Stop:       ${fmt(stop)} (1%)`,
        tp ? `Target:     ${fmt(tp)}` : `Target:     awaiting`,
        rr ? `R:R:        ${rr.toFixed(2)}:1` : ``,
        `Conviction: ${conviction}%`,
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
