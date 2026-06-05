// Chanakya Bullish Scanner — daily multi-indicator confluence signal.
//
// Fires when ALL 16 conditions pass on daily candles (ChartInk screener #33489):
//   1.  Volume SMA(14) >= 100 000
//   2.  MACD Line(slow=14,fast=5,signal=3) >= MACD Signal
//   3.  ADX DI+(14) >= ADX DI-(14)
//   4.  Slow Stoch %K(5,3) >= Slow Stoch %D
//   5.  Fast Stoch %K(5,3) >= Fast Stoch %D
//   6.  MACD Histogram(14,5,3) > 0
//   7.  RSI(14) >= 70
//   8.  Close >= EMA(close, 6)
//   9.  CCI(14) > 0
//  10.  Close > Parabolic SAR(0.02, 0.02, 0.2)
//  11.  StochRSI(14) >= 80
//  12.  MFI(14) >= 80
//  13.  Williams %R(14) >= −20
//  14.  Ichimoku Conversion(5,14,26) >= Ichimoku Base
//  15.  Ichimoku Span A(5,14,26) >= Ichimoku Span B
//  16.  Close >= Ichimoku Cloud Top(5,14,26)
//
// MACD convention: ChartInk lists parameters as (slow, fast, signal).
// (14,5,3) → slow=14, fast=5 → MACD = EMA(5)−EMA(14), positive in uptrends.
//
// Run schedule: 07:00 IST (pre-market, uses previous day's close) and
//               16:30 IST (post-market, uses today's close).
//
// Debug mode: GET /scan-chanakya?symbol=RELIANCE  → returns computed values,
//             no DB writes.

import { createServiceClient } from "../_shared/supabase.ts";
import {
  sma, ema, rsi, macd, adx, stochasticFast, stochasticSlow,
  cci, parabolicSar, stochRsi, mfi, williamsR, ichimoku,
} from "../_shared/indicators.ts";

const EXCHANGE = "NSE";
const ANGEL_BASE = "https://apiconnect.angelone.in";
const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const NIFTY200_SYMBOLS = [
  "ADANIENT","ADANIPORTS","APOLLOHOSP","ASIANPAINT","AXISBANK",
  "BAJAJ-AUTO","BAJFINANCE","BAJAJFINSV","BPCL","BHARTIARTL",
  "BRITANNIA","CIPLA","COALINDIA","DIVISLAB","DRREDDY",
  "EICHERMOT","GRASIM","HCLTECH","HDFCBANK","HDFCLIFE",
  "HEROMOTOCO","HINDALCO","HINDUNILVR","ICICIBANK","ITC",
  "INDUSINDBK","INFY","JSWSTEEL","KOTAKBANK","LTIM",
  "LT","M&M","MARUTI","NTPC","NESTLEIND",
  "ONGC","POWERGRID","RELIANCE","SBILIFE","SBIN",
  "SUNPHARMA","TCS","TATACONSUM","TMCV","TATASTEEL",
  "TECHM","TITAN","ULTRACEMCO","UPL","WIPRO",
  "ADANIGREEN","ADANIENSOL","AMBUJACEM","APLAPOLLO","ATGL",
  "AUBANK","BERGEPAINT","BOSCHLTD","CANBK","CHOLAFIN",
  "DLF","DMART","GODREJCP","GODREJPROP","HAL",
  "HAVELLS","HDFCAMC","ICICIGI","ICICIPRULI","INDHOTEL",
  "INDUSTOWER","IRFC","JSWENERGY","LICI","LODHA",
  "MARICO","MCDOWELL-N","MPHASIS","MUTHOOTFIN","NAUKRI",
  "NHPC","OFSS","PIDILITIND","PIIND","PNB",
  "RECLTD","SAIL","SHREECEM","SIEMENS","SRF",
  "TATAPOWER","TORNTPHARM","TRENT","TVSMOTOR","VBL",
  "VEDL","ETERNAL","ZYDUSLIFE","INDIGO","YESBANK",
  "ABB","ABCAPITAL","ABFRL","ACC","ALKEM",
  "ASHOKLEY","BALKRISIND","BANDHANBNK","BATAINDIA","BEL",
  "BIOCON","BLUESTARCO","CANFINHOME","CEAT","CGPOWER",
  "CROMPTON","CUMMINSIND","DABUR","DEEPAKNTR","DIXON",
  "ESCORTS","EXIDEIND","FEDERALBNK","GLENMARK","GMRINFRA",
  "GRANULES","HONAUT","IDFCFIRSTB","IGL","INDIAMART",
  "JSL","JUBLFOOD","KANSAINER","KARURVYSYA","KAYNES",
  "KPITTECH","LAURUSLABS","LICHSGFIN","LINDEINDIA","LUPIN",
  "MFSL","MOTHERSON","PAGEIND","PERSISTENT","PETRONET",
  "PHOENIXLTD","PNBHOUSING","POLYCAB","RADICO","RAMCOCEM",
  "SBICARD","SOBHA","STARHEALTH","SUNDARMFIN","SUPREMEIND",
  "SYNGENE","TATACHEM","TATAELXSI","TORNTPOWER","TRIDENT",
  "UBL","UNIONBANK","VOLTAS","WHIRLPOOL","RAYMOND",
  "BSE","CDSL","MCX",
] as const;

// ---------------------------------------------------------------------------
// IST date helpers
// ---------------------------------------------------------------------------

// The trading date whose daily close is used for this scan invocation.
// Pre-market (<10:00 UTC / <15:30 IST): use last completed trading day.
// Post-market (≥10:00 UTC / ≥15:30 IST on a weekday): use today.
function tradingDateForScan(): string {
  const nowMs = Date.now() + 5.5 * 3600 * 1000;
  const now = new Date(nowMs);
  const dow = now.getUTCDay();
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  const marketCloseIstMin = 930; // 15:30 IST = 15*60+30
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

// ---------------------------------------------------------------------------
// Angel One auth (self-contained — mirrors refresh-prices to avoid coupling)
// ---------------------------------------------------------------------------

async function generateTotp(secret: string): Promise<string> {
  const stripped = secret.replace(/[-\s]/g, "");
  const isHex = /^[0-9a-fA-F]+$/.test(stripped) && stripped.length % 2 === 0;
  let keyBytes: Uint8Array;
  if (isHex) {
    keyBytes = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  } else {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = stripped.toUpperCase().replace(/=/g, "");
    let bits = "";
    for (const ch of cleaned) { const v = alphabet.indexOf(ch); bits += (v === -1 ? 0 : v).toString(2).padStart(5, "0"); }
    keyBytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
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
    "Content-Type": "application/json", "Accept": "application/json",
    "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "1.1.1.1",
    "X-MACAddress": "00-00-00-00-00-00", "X-PrivateKey": apiKey,
  };
  if (jwtToken) h["Authorization"] = `Bearer ${jwtToken}`;
  return h;
}

async function authenticate(): Promise<{ apiKey: string; jwtToken: string }> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");
  if (!apiKey || !secretKey || !clientId || !pin) throw new Error("Missing Angel One secrets");
  const totp = await generateTotp(secretKey);
  const resp = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST", headers: angelHeaders(apiKey),
    body: JSON.stringify({ clientcode: clientId, password: pin, totp }),
  });
  const data = await resp.json();
  if (!data?.status || !data?.data?.jwtToken) throw new Error(`Angel One login failed: ${data?.message ?? JSON.stringify(data)}`);
  return { apiKey, jwtToken: data.data.jwtToken as string };
}

type Candle = [string, number, number, number, number, number]; // [ts, open, high, low, close, volume]

async function fetchDailyCandles(
  apiKey: string, jwtToken: string, token: string,
): Promise<Candle[]> {
  const todate = tradingDateForScan() + " 15:30";
  const resp = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: "POST", headers: angelHeaders(apiKey, jwtToken),
    body: JSON.stringify({ exchange: EXCHANGE, symboltoken: token, interval: "ONE_DAY", fromdate: historicalFromDate(), todate }),
  });
  const data = await resp.json();
  return (data?.data ?? []) as Candle[];
}

// ---------------------------------------------------------------------------
// Token resolution (same logic as refresh-prices)
// ---------------------------------------------------------------------------

type DbInstrument = { id: string; symbol: string; angel_one_token: string | null };

type ChanakyaAlert = ReturnType<typeof buildAlert>;

type StrategyLookup = {
  id: string;
  name: string;
};

async function resolveTokens(
  instruments: DbInstrument[], supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  const need = instruments.filter((i) => !i.angel_one_token);
  if (!need.length) return;
  const resp = await fetch(SCRIP_MASTER_URL);
  if (!resp.ok) return;
  type Entry = { token: string; symbol: string; exch_seg: string; instrumenttype: string };
  const master = await resp.json() as Entry[];
  const map = new Map<string, string>();
  for (const e of master) {
    if (e.exch_seg === "NSE" && e.instrumenttype === "") map.set(e.symbol.replace(/-EQ$/, ""), e.token);
  }
  for (const inst of need) {
    const token = map.get(inst.symbol);
    if (!token) continue;
    inst.angel_one_token = token;
    await supabase.from("instruments").update({ angel_one_token: token }).eq("id", inst.id);
  }
}

// ---------------------------------------------------------------------------
// Chanakya indicator computation
// ---------------------------------------------------------------------------

interface ChanakyaResult {
  passes: boolean;
  conditions: Record<string, { value: number | string; pass: boolean }>;
  close: number;
  volMultiplier: number;
  rsiValue: number;
}

function computeChanakya(candles: Candle[]): ChanakyaResult | null {
  const MIN_CANDLES = 70;
  if (candles.length < MIN_CANDLES) return null;

  const highs   = candles.map((c) => c[2]);
  const lows    = candles.map((c) => c[3]);
  const closes  = candles.map((c) => c[4]);
  const volumes = candles.map((c) => c[5]);

  const close = closes[closes.length - 1];
  const volSma14 = sma(volumes, 14);
  const macdResult = macd(closes, 14, 5, 3);
  const adxResult = adx(highs, lows, closes, 14);
  const slowStoch = stochasticSlow(highs, lows, closes, 5, 3);
  const fastStoch = stochasticFast(highs, lows, closes, 5, 3);
  const rsiVal = rsi(closes, 14);
  const ema6 = ema(closes, 6);
  const cciVal = cci(highs, lows, closes, 14);
  const sar = parabolicSar(highs, lows, closes, 0.02, 0.02, 0.2);
  const stochRsiVal = stochRsi(closes, 14);
  const mfiVal = mfi(highs, lows, closes, volumes, 14);
  const wrVal = williamsR(highs, lows, closes, 14);
  const ichi = ichimoku(highs, lows, 5, 14, 26);

  const volMultiplier = Math.max(volSma14 > 0 ? parseFloat((volumes[volumes.length - 1] / volSma14).toFixed(2)) : 1, 0.01);

  const conditions: Record<string, { value: number | string; pass: boolean }> = {
    "Vol SMA(14) ≥ 100k":          { value: Math.round(volSma14), pass: volSma14 >= 100_000 },
    "MACD Line ≥ Signal":           { value: `${macdResult.line.toFixed(3)} vs ${macdResult.signalLine.toFixed(3)}`, pass: macdResult.line >= macdResult.signalLine },
    "ADX DI+ ≥ DI-":               { value: `${adxResult.diPlus.toFixed(2)} vs ${adxResult.diMinus.toFixed(2)}`, pass: adxResult.diPlus >= adxResult.diMinus },
    "Slow Stoch %K ≥ %D":          { value: `${slowStoch.k.toFixed(2)} vs ${slowStoch.d.toFixed(2)}`, pass: slowStoch.k >= slowStoch.d },
    "Fast Stoch %K ≥ %D":          { value: `${fastStoch.k.toFixed(2)} vs ${fastStoch.d.toFixed(2)}`, pass: fastStoch.k >= fastStoch.d },
    "MACD Histogram > 0":           { value: macdResult.histogram.toFixed(4), pass: macdResult.histogram > 0 },
    "RSI(14) ≥ 70":                 { value: parseFloat(rsiVal.toFixed(2)), pass: rsiVal >= 70 },
    "Close ≥ EMA(6)":               { value: `${close.toFixed(2)} vs ${ema6.toFixed(2)}`, pass: close >= ema6 },
    "CCI(14) > 0":                  { value: parseFloat(cciVal.toFixed(2)), pass: cciVal > 0 },
    "Close > Parabolic SAR":        { value: `${close.toFixed(2)} vs ${sar.toFixed(2)}`, pass: close > sar },
    "StochRSI(14) ≥ 80":            { value: parseFloat(stochRsiVal.toFixed(2)), pass: stochRsiVal >= 80 },
    "MFI(14) ≥ 80":                 { value: parseFloat(mfiVal.toFixed(2)), pass: mfiVal >= 80 },
    "Williams %R(14) ≥ −20":        { value: parseFloat(wrVal.toFixed(2)), pass: wrVal >= -20 },
    "Ichimoku Conv ≥ Base":         { value: `${ichi.conversion.toFixed(2)} vs ${ichi.base.toFixed(2)}`, pass: ichi.conversion >= ichi.base },
    "Ichimoku Span A ≥ Span B":     { value: `${ichi.spanA.toFixed(2)} vs ${ichi.spanB.toFixed(2)}`, pass: ichi.spanA >= ichi.spanB },
    "Close ≥ Ichimoku Cloud Top":   { value: `${close.toFixed(2)} vs ${ichi.cloudTop.toFixed(2)}`, pass: close >= ichi.cloudTop },
  };

  // Any NaN indicator means we cannot evaluate → skip
  for (const [, v] of Object.entries(conditions)) {
    if (typeof v.value === "number" && isNaN(v.value)) return null;
    if (typeof v.value === "string" && v.value.includes("NaN")) return null;
  }

  const passes = Object.values(conditions).every((c) => c.pass);
  return { passes, conditions, close, volMultiplier, rsiValue: rsiVal };
}

// ---------------------------------------------------------------------------
// Alert builder
// ---------------------------------------------------------------------------

function buildAlert(inst: DbInstrument, result: ChanakyaResult, today: string) {
  const { close, volMultiplier, rsiValue, conditions } = result;

  const conds = Object.entries(conditions);
  const passCount = conds.filter(([, v]) => v.pass).length;

  return {
    instrument_id: inst.id,
    alert_type: "chanakya_bullish",
    dedupe_key: [inst.id, "chanakya_bullish", "bullish", today].join(":"),
    direction: "bullish",
    market_session: "daily_scan",
    title: `${inst.symbol} — Chanakya bullish (${passCount}/16 conditions)`,
    thesis: `${inst.symbol} satisfies all 16 Chanakya bullish conditions on the daily chart. RSI ${rsiValue.toFixed(1)}, price above Ichimoku cloud, MACD + momentum aligned. High-conviction swing long setup.`,
    trigger_price: close,
    current_price: close,
    take_profit_price: null,
    swept_level: close,
    swept_level_name: "Multi-indicator confluence",
    volume_multiplier: volMultiplier,
    conviction_score: 85,
    score_factors: [
      { name: "RSI(14)",          score: rsiValue >= 80 ? 25 : 20, state: `${rsiValue.toFixed(1)}` },
      { name: "Ichimoku cloud",   score: 20, state: `price above cloud (${conditions["Close ≥ Ichimoku Cloud Top"].value})` },
      { name: "MACD + Stoch",     score: 20, state: "all momentum aligned" },
      { name: "MFI / volume",     score: 20, state: `MFI ${conditions["MFI(14) ≥ 80"].value}, ${volMultiplier}× avg volume` },
    ],
    timeframe_alignment: {
      daily: `All 16 Chanakya conditions passed`,
      momentum: `RSI ${rsiValue.toFixed(1)}, StochRSI ${conditions["StochRSI(14) ≥ 80"].value}`,
      volume: `MFI ${conditions["MFI(14) ≥ 80"].value}, vol ${volMultiplier}×`,
      trend: `Price above SAR + Ichimoku cloud, MACD bullish`,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function enqueueBotSignals(
  supabase: ReturnType<typeof createServiceClient>,
  alerts: ChanakyaAlert[],
): Promise<{ queued: number; skipped: number; error?: string }> {
  if (alerts.length === 0) return { queued: 0, skipped: 0 };

  const { data: strategy, error: strategyError } = await supabase
    .from("bot_strategies")
    .select("id,name")
    .eq("name", "chanakya_bullish")
    .eq("enabled", true)
    .neq("lifecycle_status", "disabled")
    .maybeSingle();

  if (strategyError) return { queued: 0, skipped: alerts.length, error: strategyError.message };
  if (!strategy?.id) return { queued: 0, skipped: alerts.length };

  const strategyRow = strategy as StrategyLookup;
  const nowIso = new Date().toISOString();
  const signals = alerts.map((alert) => {
    const triggerPrice = alert.current_price;
    return {
      strategy_id: strategyRow.id,
      source: "chanakya_bullish",
      instrument_id: alert.instrument_id,
      side: "long",
      signal_time: nowIso,
      trigger_price: Number(triggerPrice.toFixed(4)),
      stop_loss_price: Number((triggerPrice * 0.97).toFixed(4)),
      target_price: Number((triggerPrice * 1.06).toFixed(4)),
      timeframe: "1d",
      metadata: {
        alert_dedupe_key: alert.dedupe_key,
        alert_title: alert.title,
        volume_multiplier: alert.volume_multiplier,
        timeframe_alignment: alert.timeframe_alignment,
        source_system: "market_sniper_chanakya",
      },
    };
  });

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

  const { error } = await supabase.from("bot_trade_signals").insert(missingSignals);
  if (error) {
    const isDuplicateRace = "code" in error && error.code === "23505";
    return {
      queued: 0,
      skipped: alerts.length,
      error: isDuplicateRace ? undefined : error.message,
    };
  }

  return { queued: missingSignals.length, skipped: alerts.length - missingSignals.length };
}

// ---------------------------------------------------------------------------
// Telegram notification
// ---------------------------------------------------------------------------

async function sendTelegram(alerts: Record<string, unknown>[]) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  for (const alert of alerts) {
    try {
      const symbol = (alert.title as string).split(" ")[0];
      const entry = alert.current_price as number;
      const conviction = alert.conviction_score as number;
      const rsiLine = (alert.timeframe_alignment as Record<string, string>).momentum;
      const volLine = (alert.timeframe_alignment as Record<string, string>).volume;
      const text = [
        `🎯 *CHANAKYA BULLISH SIGNAL*`,
        ``,
        `📈 *LONG — ${symbol}*`,
        `_${alert.title}_`,
        ``,
        `Entry:       ₹${entry.toFixed(2)}`,
        `Stop:        ₹${(entry * 0.97).toFixed(2)} (3% swing)`,
        `Target:      awaiting — no fixed TP`,
        `Conviction:  ${conviction}%`,
        ``,
        `${rsiLine}`,
        `${volLine}`,
        `All 16 daily indicators aligned 🔥`,
      ].join("\n");
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
      });
    } catch (err) {
      console.error("[scan-chanakya] Telegram failed:", err instanceof Error ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const debugSymbol = url.searchParams.get("symbol");
  const findTokens = url.searchParams.get("find_tokens") === "1";

  let apiKey: string, jwtToken: string;
  try {
    ({ apiKey, jwtToken } = await authenticate());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // One-shot token finder: ?find_tokens=1
  // Searches Angel One's searchScrip API for instruments missing a token and updates the DB.
  if (findTokens) {
    try {
      const supabase = createServiceClient();
      const { data: missing, error: missingErr } = await supabase
        .from("instruments").select("id, symbol").eq("exchange", EXCHANGE).is("angel_one_token", null);
      if (missingErr) return Response.json({ error: missingErr.message }, { status: 500 });
      const results: Record<string, unknown>[] = [];
      for (const inst of (missing ?? [])) {
        await new Promise((r) => setTimeout(r, 300));
        let token: string | null = null;
        let rawSr = "";
        try {
          const sr = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/searchScrip`, {
            method: "POST", headers: angelHeaders(apiKey, jwtToken),
            body: JSON.stringify({ exchange: "NSE", searchscrip: inst.symbol }),
          });
          rawSr = await sr.text();
          const srData = JSON.parse(rawSr) as { data?: Array<{ symboltoken: string; tradingsymbol: string }> };
          const entry = (srData?.data ?? []).find(
            (e) => e.tradingsymbol === inst.symbol || e.tradingsymbol === `${inst.symbol}-EQ`,
          );
          token = entry?.symboltoken ?? null;
        } catch (e) {
          results.push({ symbol: inst.symbol, token: null, updated: false, error: String(e), raw: rawSr.slice(0, 100) });
          continue;
        }
        let updated = false;
        if (token) {
          const { error: ue } = await supabase.from("instruments").update({ angel_one_token: token }).eq("id", inst.id);
          updated = !ue;
        }
        results.push({ symbol: inst.symbol, token, updated });
      }
      return Response.json({ find_tokens: true, results, updated: results.filter((r) => r.updated).length });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  const supabase = createServiceClient();

  // Fetch instruments with Angel One tokens
  const symbolFilter = debugSymbol ? [debugSymbol.toUpperCase()] : (NIFTY200_SYMBOLS as unknown as string[]);
  const { data: rawInst, error: instErr } = await supabase
    .from("instruments")
    .select("id, symbol, angel_one_token")
    .eq("exchange", EXCHANGE)
    .in("symbol", symbolFilter);

  if (instErr) return Response.json({ error: instErr.message }, { status: 500 });

  const instruments = (rawInst ?? []) as DbInstrument[];
  await resolveTokens(instruments, supabase);

  const today = tradingDateForScan();
  const matched: ChanakyaResult[] = [];
  const alerts: ReturnType<typeof buildAlert>[] = [];
  const debugResults: Record<string, unknown>[] = [];

  for (const inst of instruments) {
    if (!inst.angel_one_token) {
      if (debugSymbol) debugResults.push({ symbol: inst.symbol, passes: null, candles: 0, error: "no_token" });
      continue;
    }
    try {
      const candles = await fetchDailyCandles(apiKey, jwtToken, inst.angel_one_token);
      if (candles.length < 70) {
        if (debugSymbol) debugResults.push({ symbol: inst.symbol, passes: null, candles: candles.length, error: "insufficient_candles" });
        continue;
      }

      const result = computeChanakya(candles);
      if (!result) {
        if (debugSymbol) debugResults.push({ symbol: inst.symbol, passes: null, candles: candles.length, error: "nan_indicator" });
        continue;
      }

      if (debugSymbol) {
        debugResults.push({ symbol: inst.symbol, passes: result.passes, candles: candles.length, conditions: result.conditions });
        continue;
      }

      if (result.passes) {
        matched.push(result);
        alerts.push(buildAlert(inst, result, today) as ReturnType<typeof buildAlert>);
      }
    } catch (err) {
      console.error(`[scan-chanakya] ${inst.symbol}:`, err instanceof Error ? err.message : err);
    }
    // Respect Angel One rate limit
    await new Promise((r) => setTimeout(r, 150));
  }

  // Debug mode: return computed values only, no DB writes
  if (debugSymbol) {
    return Response.json({ debug: true, trading_date: today, results: debugResults });
  }

  if (!alerts.length) return Response.json({ upserted: 0, matched: 0, trading_date: today });

  // Deduplicate against existing
  const keys = alerts.map((a) => a.dedupe_key);
  const { data: existing } = await supabase.from("alerts").select("dedupe_key").in("dedupe_key", keys);
  const existingKeys = new Set((existing ?? []).map((r: { dedupe_key: string }) => r.dedupe_key));
  const newAlerts = alerts.filter((a) => !existingKeys.has(a.dedupe_key));

  const { error: upsertErr } = await supabase
    .from("alerts")
    .upsert(alerts, { onConflict: "dedupe_key" });
  if (upsertErr) return Response.json({ error: upsertErr.message }, { status: 500 });

  if (newAlerts.length) await sendTelegram(newAlerts as unknown as Record<string, unknown>[]);
  const botQueue = await enqueueBotSignals(supabase, alerts);

  return Response.json({
    upserted: alerts.length,
    new_alerts: newAlerts.length,
    matched: matched.length,
    bot_signals_queued: botQueue.queued,
    bot_signals_skipped: botQueue.skipped,
    bot_signal_error: botQueue.error ?? null,
    trading_date: today,
    symbols: alerts.map((a) => a.title.split(" ")[0]),
  });
});
