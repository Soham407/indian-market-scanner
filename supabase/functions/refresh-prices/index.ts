// Requires Supabase secrets:
//   AngelOne_Apikey   – Angel One SmartAPI API key
//   AngelOne_SecretKey – TOTP seed (base32) from the Angel One TOTP setup screen
//   AngelOne_ClientID  – Broker client ID (login ID)
//   AngelOne_PIN       – Broker login PIN / password

import { SmartAPI } from "npm:smartapi-javascript";
import * as OTPAuth from "npm:otpauth";
import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";

const EXCHANGE = "NSE";

// Official Nifty 50 constituent symbols as used by NSE/Angel One
const NIFTY50_SYMBOLS = [
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
  "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BPCL", "BHARTIARTL",
  "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
  "EICHERMOT", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE",
  "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC",
  "INDUSINDBK", "INFY", "JSWSTEEL", "KOTAKBANK", "LTIM",
  "LT", "M&M", "MARUTI", "NTPC", "NESTLEIND",
  "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN",
  "SUNPHARMA", "TCS", "TATACONSUM", "TATAMOTORS", "TATASTEEL",
  "TECHM", "TITAN", "ULTRACEMCO", "UPL", "WIPRO",
] as const;

type DbInstrument = {
  id: string;
  symbol: string;
  exchange: string;
  angel_one_token: string | null;
  previous_day_high: number | null;
  pdh_refreshed_at: string | null;
};

// deno-lint-ignore no-explicit-any
type AngelApi = any;

type AngelQuote = {
  symbolToken: string;
  tradingSymbol: string;
  open: number;
  high: number;
  low: number;
  // `close` in a live FULL-mode quote is the *previous session's* closing price
  close: number;
  ltp: number;
  volume: number;
  // Angel One uses either avgPrice or averagePrice depending on SDK version
  avgPrice?: number;
  averagePrice?: number;
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function authenticate(): Promise<AngelApi> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");

  if (!apiKey || !secretKey || !clientId || !pin) {
    throw new Error(
      "Missing Supabase secrets: AngelOne_Apikey, AngelOne_SecretKey, AngelOne_ClientID, AngelOne_PIN",
    );
  }

  // Generate the current TOTP from the base32 TOTP seed stored as AngelOne_SecretKey
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    // Normalise: strip spaces, force upper-case (Angel One base32 seeds are upper-case)
    secret: OTPAuth.Secret.fromBase32(
      secretKey.toUpperCase().replace(/\s+/g, ""),
    ),
  });

  const api = new SmartAPI({ api_key: apiKey });

  // generateSession MUST complete before any other API call.
  // The SDK stores the JWT internally after this call.
  const session = await api.generateSession(clientId, pin, totp.generate());

  if (!session?.status) {
    throw new Error(
      `Angel One session rejected: ${session?.message ?? "no details"}`,
    );
  }

  return api;
}

// ---------------------------------------------------------------------------
// Token resolution – runs once per instrument, result cached in the DB
// ---------------------------------------------------------------------------

async function resolveTokens(
  api: AngelApi,
  instruments: DbInstrument[],
  supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  const needsToken = instruments.filter((i) => !i.angel_one_token);
  if (needsToken.length === 0) return;

  for (const inst of needsToken) {
    try {
      const result = await api.searchScrip(EXCHANGE, inst.symbol);
      const scrips: Array<{ tradingSymbol: string; symbolToken: string; name?: string }> =
        result?.data ?? [];

      // Prefer the equity series (SYMBOL-EQ); fall back to first result
      const match =
        scrips.find((s) => s.tradingSymbol === `${inst.symbol}-EQ`) ??
        scrips[0];

      if (!match?.symbolToken) continue;

      const patch: Record<string, string> = {
        angel_one_token: match.symbolToken,
      };
      // Enrich the human-readable name if the API returned one
      if (match.name) patch.name = match.name;

      await supabase.from("instruments").update(patch).eq("id", inst.id);
      inst.angel_one_token = match.symbolToken;
    } catch (err) {
      console.error(
        `[refresh-prices] token resolution failed for ${inst.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Throttle to respect Angel One rate limits
    await new Promise((r) => setTimeout(r, 120));
  }
}

// ---------------------------------------------------------------------------
// Previous-day OHLC refresh (pre-market, once per trading day)
// ---------------------------------------------------------------------------

function lastTradingDateIst(): string {
  // Compute "today" in IST, then step back past weekends
  const nowIstMs = Date.now() + 5.5 * 3600 * 1000;
  const dayOfWeek = new Date(nowIstMs).getUTCDay(); // 0=Sun … 6=Sat

  // Days to step back to reach the most recent weekday
  const daysBack = dayOfWeek === 0 ? 2 : dayOfWeek === 1 ? 3 : 1;
  const lastTradingIstMs = nowIstMs - daysBack * 86400 * 1000;
  return new Date(lastTradingIstMs).toISOString().slice(0, 10);
}

function isTodayIst(ts: string | null): boolean {
  if (!ts) return false;
  const nowDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const tsDate = new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  return nowDate === tsDate;
}

async function refreshPreviousDayOhlc(
  api: AngelApi,
  instruments: DbInstrument[],
  supabase: ReturnType<typeof createServiceClient>,
): Promise<number> {
  // Only fetch for instruments whose PDH has not been refreshed today
  const stale = instruments.filter(
    (i) => i.angel_one_token && !isTodayIst(i.pdh_refreshed_at),
  );
  if (stale.length === 0) return 0;

  const yDate = lastTradingDateIst();
  let updated = 0;

  for (const inst of stale) {
    try {
      const hist = await api.getCandleData({
        exchange: EXCHANGE,
        symboltoken: inst.angel_one_token!,
        interval: "ONE_DAY",
        fromdate: `${yDate} 09:00`,
        todate: `${yDate} 15:30`,
      });

      // Response: [[timestamp, open, high, low, close, volume], ...]
      const candles: [string, number, number, number, number, number][] =
        hist?.data ?? [];

      if (candles.length === 0) continue;

      const [, , high, low, close, volume] = candles[candles.length - 1];
      if (!high) continue;

      await supabase
        .from("instruments")
        .update({
          previous_day_high: high,
          previous_day_low: low,
          previous_close: close,
          prev_day_volume: typeof volume === "number" && volume > 0 ? volume : null,
          pdh_refreshed_at: new Date().toISOString(),
        })
        .eq("id", inst.id);

      updated++;
    } catch (err) {
      console.error(
        `[refresh-prices] previous-day OHLC refresh failed for ${inst.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Angel One historical API is rate-limited; 150 ms between calls is safe
    await new Promise((r) => setTimeout(r, 150));
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async () => {
  const session = getMarketSessionStatus();

  // Authenticate first — required for both pre-market PDH refresh and live prices
  let api: AngelApi;
  try {
    api = await authenticate();
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const supabase = createServiceClient();

  // Ensure every Nifty 50 symbol has a row in the instruments table.
  // Uses DO NOTHING on conflict so existing rows are never overwritten here.
  await supabase.from("instruments").upsert(
    NIFTY50_SYMBOLS.map((symbol) => ({
      symbol,
      exchange: EXCHANGE,
      name: symbol, // placeholder; overwritten when token is resolved via searchScrip
    })),
    { onConflict: "symbol,exchange", ignoreDuplicates: true },
  );

  const { data: rawInstruments, error: instErr } = await supabase
    .from("instruments")
    .select("id,symbol,exchange,angel_one_token,previous_day_high,pdh_refreshed_at")
    .eq("exchange", EXCHANGE)
    .in("symbol", NIFTY50_SYMBOLS as unknown as string[]);

  if (instErr) {
    return Response.json({ error: instErr.message }, { status: 500 });
  }

  const instruments = (rawInstruments ?? []) as DbInstrument[];

  // Resolve Angel One symbolTokens for any instruments that don't have one yet.
  // After the first successful run for each symbol this becomes a no-op.
  await resolveTokens(api, instruments, supabase);

  if (!session.isOpen) {
    // Pre-market window (08:30–09:14 IST): refresh previous-day OHLC so that
    // scan-alerts has accurate PDH / PDL / previous_close data for the session.
    const pdhRefreshed = await refreshPreviousDayOhlc(api, instruments, supabase);

    return Response.json({
      status: "Market closed, standing by.",
      market: EXCHANGE,
      weekday: session.weekday,
      ist_time: session.istTime,
      pdh_refreshed: pdhRefreshed,
    });
  }

  // -----------------------------------------------------------------------
  // Market hours: batch-fetch live OHLCV via a single getMarketData call
  // -----------------------------------------------------------------------

  const tokens = instruments
    .map((i) => i.angel_one_token)
    .filter(Boolean) as string[];

  if (tokens.length === 0) {
    return Response.json({
      refreshed: 0,
      note: "Token resolution still in progress; will retry next invocation.",
    });
  }

  let quotes: AngelQuote[] = [];
  try {
    const mktResp = await api.getMarketData({
      mode: "FULL",
      exchangeTokens: { [EXCHANGE]: tokens },
    });
    quotes = mktResp?.data?.fetched ?? [];
  } catch (err) {
    return Response.json(
      {
        error: `Market data fetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 500 },
    );
  }

  const tokenToId = new Map(
    instruments
      .filter((i) => i.angel_one_token)
      .map((i) => [i.angel_one_token!, i.id]),
  );

  const priceMarks: { instrument_id: string; price: number; source: string }[] =
    [];
  let updatedCount = 0;

  for (const quote of quotes) {
    const instrumentId = tokenToId.get(quote.symbolToken);
    if (!instrumentId || !quote.ltp || quote.ltp <= 0) continue;

    // avgPrice / averagePrice: Angel One returns an intraday VWAP approximation.
    // Field name differs across SDK versions; handle both.
    const rawVwap = quote.avgPrice ?? quote.averagePrice ?? null;
    const rawPrevClose = quote.close ?? null;

    // Sanity-filter optional fields. A zero or null VWAP from a flaky quote
    // would silently corrupt every downstream alert's take-profit target —
    // skip the column write instead of poisoning the row.
    const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);

    const patch: Record<string, number | string> = { last_price: quote.ltp };
    if (typeof rawVwap === "number" && rawVwap > 0) {
      patch.vwap = rawVwap;
    } else if (rawVwap !== null) {
      console.warn(
        `[refresh-prices] skipping vwap write for ${quote.tradingSymbol}: invalid value ${rawVwap}`,
      );
    }
    if (typeof rawPrevClose === "number" && rawPrevClose > 0) {
      // `close` in a live FULL quote = previous session's official close price
      patch.previous_close = rawPrevClose;
    } else if (rawPrevClose !== null) {
      console.warn(
        `[refresh-prices] skipping previous_close write for ${quote.tradingSymbol}: invalid value ${rawPrevClose}`,
      );
    }
    // Session high and volume reset automatically each day: session_date is the
    // IST date string written alongside them. scan-alerts checks session_date ===
    // today before trusting session_high, so yesterday's stale high is never used.
    if (typeof quote.high === "number" && quote.high > 0) {
      patch.session_high = quote.high;
      patch.session_date = todayIst;
    }
    if (typeof quote.volume === "number" && quote.volume > 0) {
      patch.session_volume = quote.volume;
    }

    // Update live price fields. `updated_at` is handled by the DB trigger.
    await supabase.from("instruments").update(patch).eq("id", instrumentId);

    priceMarks.push({
      instrument_id: instrumentId,
      price: quote.ltp,
      source: "angel_one",
    });

    // Keep open shadow trade marks in sync with the live price.
    // Skip rows already at this exact price to avoid firing the
    // updated_at trigger and a realtime broadcast on no-op writes.
    await supabase
      .from("shadow_trades")
      .update({ current_price: quote.ltp })
      .eq("instrument_id", instrumentId)
      .eq("status", "open")
      .neq("current_price", quote.ltp);

    updatedCount++;
  }

  if (priceMarks.length > 0) {
    const { error: markError } = await supabase
      .from("price_marks")
      .insert(priceMarks);

    if (markError) {
      return Response.json({ error: markError.message }, { status: 500 });
    }
  }

  return Response.json({ refreshed: updatedCount, source: "angel_one" });
});
