import {
  getMarketSessionStatus,
  marketClosedResponse,
} from "../_shared/market-hours.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  align1mCandlesToPoints,
  type AngelInstrument,
  type AtmOptionPair,
  buildPremiumDecayPoint,
  collectOptionTokens,
  indexBatchLtps,
  PREMIUM_DECAY_BAND_SERIES_KEY,
  PREMIUM_DECAY_SERIES_KEY,
  type PremiumDecayBaseline,
  requireBatchLtp,
  selectAtmBandPairs,
  selectNearestAtmOptionPair,
} from "./premium-decay.ts";

const ANGEL_BASE = "https://apiconnect.angelone.in";
const SCRIP_MASTER_URLS = [
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
];
const NIFTY_INDEX = {
  exchange: "NSE",
  tradingSymbol: "Nifty 50",
  symbolToken: "99926000",
};
const MAX_ANGEL_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const SCRIP_MASTER_CACHE_MS = 6 * 60 * 60 * 1000;

let cachedScripMaster: AngelInstrument[] | null = null;
let cachedScripMasterAt = 0;

async function readJsonResponse(response: Response, operation: string) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `${operation} returned non-JSON HTTP ${response.status}: ${
        body.slice(0, 120)
      }`,
    );
  }
}

async function withAngelRetry<T>(
  operation: string,
  request: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ANGEL_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ANGEL_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt)
        );
      }
    }
  }

  throw new Error(
    `${operation} failed after ${MAX_ANGEL_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
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
      const value = alphabet.indexOf(ch);
      if (value === -1) {
        throw new Error("AngelOne_SecretKey is not valid hex or base32");
      }
      bits += value.toString(2).padStart(5, "0");
    }
    keyBytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < keyBytes.length; i++) {
      keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
  }

  const counter = Math.floor(Date.now() / 1000 / 30);
  const message = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = value & 0xff;
    value = Math.floor(value / 256);
  }

  const keyData = new Uint8Array(keyBytes.length);
  keyData.set(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData.buffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[19] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);

  return (code % 1_000_000).toString().padStart(6, "0");
}

function angelHeaders(
  apiKey: string,
  jwtToken?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "1.1.1.1",
    "X-MACAddress": "00-00-00-00-00-00",
    "X-PrivateKey": apiKey,
  };
  if (jwtToken) headers.Authorization = `Bearer ${jwtToken}`;
  return headers;
}

async function angelLogin(
  apiKey: string,
  clientId: string,
  pin: string,
  totp: string,
): Promise<string> {
  return await withAngelRetry("Angel One login", async () => {
    const response = await fetch(
      `${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
      {
        method: "POST",
        headers: angelHeaders(apiKey),
        body: JSON.stringify({ clientcode: clientId, password: pin, totp }),
      },
    );
    const data = await readJsonResponse(response, "Angel One login");
    if (!data?.status || !data?.data?.jwtToken) {
      throw new Error(data?.message ?? JSON.stringify(data));
    }
    return data.data.jwtToken as string;
  });
}

async function angelLtp(
  apiKey: string,
  jwtToken: string,
  exchange: string,
  tradingSymbol: string,
  symbolToken: string,
): Promise<number> {
  return await withAngelRetry(
    `Angel One LTP for ${tradingSymbol}`,
    async () => {
      const response = await fetch(
        `${ANGEL_BASE}/rest/secure/angelbroking/order/v1/getLtpData`,
        {
          method: "POST",
          headers: angelHeaders(apiKey, jwtToken),
          body: JSON.stringify({
            exchange,
            tradingsymbol: tradingSymbol,
            symboltoken: symbolToken,
          }),
        },
      );
      const data = await readJsonResponse(
        response,
        `Angel One LTP for ${tradingSymbol}`,
      );
      if (!data?.status || !Number.isFinite(Number(data?.data?.ltp))) {
        throw new Error(data?.message ?? JSON.stringify(data));
      }
      return Number(data.data.ltp);
    },
  );
}

async function angelBatchLtps(
  apiKey: string,
  jwtToken: string,
  exchange: string,
  symbolTokens: string[],
): Promise<Map<string, number>> {
  return await withAngelRetry(
    `Angel One batch LTP for ${symbolTokens.length} ${exchange} contracts`,
    async () => {
      const response = await fetch(
        `${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`,
        {
          method: "POST",
          headers: angelHeaders(apiKey, jwtToken),
          body: JSON.stringify({
            mode: "LTP",
            exchangeTokens: { [exchange]: symbolTokens },
          }),
        },
      );
      const data = await readJsonResponse(
        response,
        `Angel One batch LTP for ${exchange}`,
      );
      if (!data?.status || !Array.isArray(data?.data?.fetched)) {
        throw new Error(data?.message ?? JSON.stringify(data));
      }

      return indexBatchLtps(data.data.fetched);
    },
  );
}

async function angelCandleData(
  apiKey: string,
  jwtToken: string,
  params: {
    exchange: string;
    symboltoken: string;
    interval: string;
    fromdate: string;
    todate: string;
  },
): Promise<[string, number, number, number, number, number][]> {
  return await withAngelRetry(
    `Angel One getCandleData for token ${params.symboltoken}`,
    async () => {
      const response = await fetch(
        `${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`,
        {
          method: "POST",
          headers: angelHeaders(apiKey, jwtToken),
          body: JSON.stringify(params),
        },
      );
      const data = await readJsonResponse(
        response,
        `Angel One getCandleData for ${params.symboltoken}`,
      );
      return (data?.data ?? []) as [string, number, number, number, number, number][];
    },
  );
}

import niftyScripFallback from "../_shared/nifty_scrip_cache.json" with { type: "json" };

async function getScripMaster(): Promise<AngelInstrument[]> {
  if (
    cachedScripMaster &&
    Date.now() - cachedScripMasterAt < SCRIP_MASTER_CACHE_MS
  ) {
    return cachedScripMaster;
  }

  let lastError: unknown;
  for (const url of SCRIP_MASTER_URLS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      cachedScripMaster = await response.json() as AngelInstrument[];
      cachedScripMasterAt = Date.now();
      return cachedScripMaster;
    } catch (err) {
      lastError = err;
    }
  }

  // If live download of 37MB times out or fails, use bundled fallback NIFTY contracts
  if (Array.isArray(niftyScripFallback) && niftyScripFallback.length > 0) {
    console.warn(`[bot-premium-decay] Remote download failed (${lastError}), using bundled NIFTY scrip master (${niftyScripFallback.length} contracts)`);
    cachedScripMaster = niftyScripFallback as AngelInstrument[];
    cachedScripMasterAt = Date.now();
    return cachedScripMaster;
  }

  throw new Error(
    `Angel One scrip master failed: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function reportCollectorFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  try {
    const supabase = createServiceClient();
    await supabase
      .from("bot_settings")
      .update({
        premium_decay_last_error_at: new Date().toISOString(),
        premium_decay_last_error_message: message,
      })
      .eq("id", 1);

    const { data: existing } = await supabase
      .from("bot_incidents")
      .select("id")
      .eq("source", "bot-premium-decay")
      .is("resolved_at", null)
      .limit(1);

    if (!existing?.length) {
      await supabase.from("bot_incidents").insert({
        severity: "critical",
        source: "bot-premium-decay",
        message,
        context: { recorded_at: new Date().toISOString() },
      });
    }
  } catch (reportingError) {
    console.error(
      "[bot-premium-decay] Could not report collector failure:",
      reportingError,
    );
  }
}

async function authenticate(): Promise<{ apiKey: string; jwtToken: string }> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");
  if (!apiKey || !secretKey || !clientId || !pin) {
    throw new Error(
      "Missing Supabase secrets: AngelOne_Apikey, AngelOne_SecretKey, AngelOne_ClientID, AngelOne_PIN",
    );
  }
  return {
    apiKey,
    jwtToken: await angelLogin(
      apiKey,
      clientId,
      pin,
      await generateTotp(secretKey),
    ),
  };
}

Deno.serve(async () => {
  const sampledAt = new Date();
  const session = getMarketSessionStatus(sampledAt);
  if (!session.isOpen) return marketClosedResponse(sampledAt);

  try {
    const supabase = createServiceClient();
    const { apiKey, jwtToken } = await authenticate();
    const underlyingLtp = await angelLtp(
      apiKey,
      jwtToken,
      NIFTY_INDEX.exchange,
      NIFTY_INDEX.tradingSymbol,
      NIFTY_INDEX.symbolToken,
    );

    const scripMaster = await getScripMaster();

    const pair = selectNearestAtmOptionPair(
      scripMaster,
      underlyingLtp,
      sampledAt,
    );
    const bandPairs = selectAtmBandPairs(scripMaster, underlyingLtp, sampledAt);
    if (bandPairs.length !== 11) {
      throw new Error(
        `Expected 11 complete NIFTY band pairs, received ${bandPairs.length}`,
      );
    }

    const optionTokens = collectOptionTokens(pair, bandPairs);
    const optionLtps = await angelBatchLtps(
      apiKey,
      jwtToken,
      "NFO",
      optionTokens,
    );
    const ceLtp = requireBatchLtp(optionLtps, pair.ce.token, pair.ce.symbol);
    const peLtp = requireBatchLtp(optionLtps, pair.pe.token, pair.pe.symbol);

    const startOfSession = `${session.istDate}T03:45:00.000Z`;
    let { data: baseline, error: baselineError } = await supabase
      .from("bot_premium_decay_points")
      .select("ce_ltp, pe_ltp, sampled_at")
      .eq("series_key", PREMIUM_DECAY_SERIES_KEY)
      .gte("sampled_at", startOfSession)
      .order("sampled_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (baselineError) {
      throw new Error(
        `Could not read premium decay baseline: ${baselineError.message}`,
      );
    }

    // Auto-Backfill: If no baseline exists for today's session or if the first sample is late,
    // fetch 1-minute historical candles from 09:15 AM IST to now.
    if (!baseline && session.isOpen) {
      try {
        console.log(`[bot-premium-decay] No morning baseline found. Running 1-minute candle backfill from 09:15 IST...`);
        const fromDateStr = `${session.istDate} 09:15`;
        const toDateStr = `${session.istDate} ${new Date(sampledAt.getTime() + 5.5 * 3600 * 1000).toISOString().slice(11, 16)}`;

        const [indexCandles, ceCandles, peCandles] = await Promise.all([
          angelCandleData(apiKey, jwtToken, {
            exchange: NIFTY_INDEX.exchange,
            symboltoken: NIFTY_INDEX.symbolToken,
            interval: "ONE_MINUTE",
            fromdate: fromDateStr,
            todate: toDateStr,
          }),
          angelCandleData(apiKey, jwtToken, {
            exchange: "NFO",
            symboltoken: pair.ce.token,
            interval: "ONE_MINUTE",
            fromdate: fromDateStr,
            todate: toDateStr,
          }),
          angelCandleData(apiKey, jwtToken, {
            exchange: "NFO",
            symboltoken: pair.pe.token,
            interval: "ONE_MINUTE",
            fromdate: fromDateStr,
            todate: toDateStr,
          }),
        ]);

        if (indexCandles.length > 0 && ceCandles.length > 0 && peCandles.length > 0) {
          const historicalPoints = align1mCandlesToPoints(
            pair,
            indexCandles,
            ceCandles,
            peCandles,
            PREMIUM_DECAY_SERIES_KEY,
          );

          if (historicalPoints.length > 0) {
            console.log(`[bot-premium-decay] Inserting ${historicalPoints.length} backfilled 1-minute points from 09:15 IST`);
            await supabase.from("bot_premium_decay_points").insert(historicalPoints);
            baseline = {
              ce_ltp: historicalPoints[0].ce_ltp,
              pe_ltp: historicalPoints[0].pe_ltp,
              sampled_at: historicalPoints[0].sampled_at,
            };
          }
        }
      } catch (backfillErr) {
        console.warn(`[bot-premium-decay] Auto-backfill warning: ${backfillErr}`);
      }
    }

    const point = buildPremiumDecayPoint(
      sampledAt,
      pair,
      underlyingLtp,
      ceLtp,
      peLtp,
      baseline as PremiumDecayBaseline | null,
    );
    const bandBaselineResults = await Promise.all(
      bandPairs.map((bp: AtmOptionPair) =>
        supabase
          .from("bot_premium_decay_points")
          .select("ce_ltp, pe_ltp")
          .eq("series_key", PREMIUM_DECAY_BAND_SERIES_KEY)
          .eq("strike", bp.strike)
          .gte("sampled_at", startOfSession)
          .order("sampled_at", { ascending: true })
          .limit(1)
          .maybeSingle()
      ),
    );

    const bandPoints = bandPairs.map((bp: AtmOptionPair, i: number) => {
      const bpCeLtp = requireBatchLtp(optionLtps, bp.ce.token, bp.ce.symbol);
      const bpPeLtp = requireBatchLtp(optionLtps, bp.pe.token, bp.pe.symbol);
      const { data: bpBaseline, error: bpBaselineError } =
        bandBaselineResults[i];
      if (bpBaselineError) {
        throw new Error(
          `Could not read band baseline for strike ${bp.strike}: ${bpBaselineError.message}`,
        );
      }
      return buildPremiumDecayPoint(
        sampledAt,
        bp,
        underlyingLtp,
        bpCeLtp,
        bpPeLtp,
        bpBaseline as PremiumDecayBaseline | null,
        PREMIUM_DECAY_BAND_SERIES_KEY,
      );
    });

    const sampledMinute = new Date(
      Math.floor(sampledAt.getTime() / 60_000) * 60_000,
    ).toISOString();
    const { data: writtenCount, error: writeError } = await supabase.rpc(
      "bot_replace_premium_decay_minute",
      {
        p_sampled_minute: sampledMinute,
        p_points: [point, ...bandPoints],
      },
    );
    if (writeError) {
      throw new Error(
        `Could not replace premium decay minute: ${writeError.message}`,
      );
    }

    // Update live NIFTY spot and collector heartbeat in bot_settings.
    // premium-decay runs every minute so this keeps nifty_current_ltp fresh.
    await supabase
      .from("bot_settings")
      .update({
        nifty_current_ltp: underlyingLtp,
        premium_decay_last_sample_at: sampledAt.toISOString(),
        premium_decay_last_error_at: null,
        premium_decay_last_error_message: null,
      })
      .eq("id", 1);

    return Response.json({
      ok: true,
      point,
      bandPointCount: bandPoints.length,
      writtenCount,
    });
  } catch (error) {
    await reportCollectorFailure(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
});
