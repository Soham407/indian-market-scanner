// Requires Supabase secrets:
//   AngelOne_Apikey   – Angel One SmartAPI API key
//   AngelOne_SecretKey – TOTP seed (base32) from the Angel One TOTP setup screen
//   AngelOne_ClientID  – Broker client ID (login ID)
//   AngelOne_PIN       – Broker login PIN / password

import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";
import {
  angelGetCandleData,
  angelGetMarketData,
  authenticateAngelOne,
  type AngelQuote,
} from "../_shared/angel-one.ts";

const EXCHANGE = "NSE";

// True during 09:15–10:14 IST — the window in which we snapshot the opening range.
function isOrBuildWindow(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  return (h === 9 && m >= 15) || (h === 10 && m < 15);
}

// Official Nifty 200 constituent symbols (Nifty 50 + Nifty Next 50 + Nifty Midcap 100)
const NIFTY200_SYMBOLS = [
  // Nifty 50
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
  // Nifty Next 50
  "ADANIGREEN", "ADANITRANS", "AMBUJACEM", "APLAPOLLO", "ATGL",
  "AUBANK", "BERGEPAINT", "BOSCHLTD", "CANBK", "CHOLAFIN",
  "DLF", "DMART", "GODREJCP", "GODREJPROP", "HAL",
  "HAVELLS", "HDFCAMC", "ICICIGI", "ICICIPRULI", "INDHOTEL",
  "INDUSTOWER", "IRFC", "JSWENERGY", "LICI", "LODHA",
  "MARICO", "MCDOWELL-N", "MPHASIS", "MUTHOOTFIN", "NAUKRI",
  "NHPC", "OFSS", "PIDILITIND", "PIIND", "PNB",
  "RECLTD", "SAIL", "SHREECEM", "SIEMENS", "SRF",
  "TATAPOWER", "TORNTPHARM", "TRENT", "TVSMOTOR", "VBL",
  "VEDL", "ZOMATO", "ZYDUSLIFE", "INDIGO", "YESBANK",
  // Nifty Midcap 100
  "ABB", "ABCAPITAL", "ABFRL", "ACC", "ALKEM",
  "ASHOKLEY", "BALKRISIND", "BANDHANBNK", "BATAINDIA", "BEL",
  "BIOCON", "BLUESTARCO", "CANFINHOME", "CEAT", "CGPOWER",
  "CROMPTON", "CUMMINSIND", "DABUR", "DEEPAKNTR", "DIXON",
  "ESCORTS", "EXIDEIND", "FEDERALBNK", "GLENMARK", "GMRINFRA",
  "GRANULES", "HONAUT", "IDFCFIRSTB", "IGL", "INDIAMART",
  "JSL", "JUBLFOOD", "KANSAINER", "KARURVYSYA", "KAYNES",
  "KPITTECH", "LAURUSLABS", "LICHSGFIN", "LINDEINDIA", "LUPIN",
  "MFSL", "MOTHERSON", "PAGEIND", "PERSISTENT", "PETRONET",
  "PHOENIXLTD", "PNBHOUSING", "POLYCAB", "RADICO", "RAMCOCEM",
  "SBICARD", "SOBHA", "STARHEALTH", "SUNDARMFIN", "SUPREMEIND",
  "SYNGENE", "TATACHEM", "TATAELXSI", "TORNTPOWER", "TRIDENT",
  "UBL", "UNIONBANK", "VOLTAS", "WHIRLPOOL", "RAYMOND",
  // High-liquidity additions outside Nifty 200
  "BSE", "CDSL", "MCX",
] as const;

type DbInstrument = {
  id: string;
  symbol: string;
  exchange: string;
  angel_one_token: string | null;
  previous_day_high: number | null;
  pdh_refreshed_at: string | null;
  session_high: number | null;
  session_low: number | null;
  or_date: string | null;
};


// ---------------------------------------------------------------------------
// Token resolution – uses the Angel One public scrip master (no auth needed)
// ---------------------------------------------------------------------------

const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

async function resolveTokens(
  instruments: DbInstrument[],
  supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  const needsToken = instruments.filter((i) => !i.angel_one_token);
  if (needsToken.length === 0) return;

  // Download the full instrument list once — public URL, no WAF issues
  const resp = await fetch(SCRIP_MASTER_URL);
  if (!resp.ok) throw new Error(`Scrip master fetch failed: ${resp.status}`);

  type ScripEntry = { token: string; symbol: string; exch_seg: string; instrumenttype: string };
  const master = await resp.json() as ScripEntry[];

  // Build lookup: NSE equity base symbol (strip "-EQ") → token
  const tokenMap = new Map<string, string>();
  for (const e of master) {
    if (e.exch_seg === "NSE" && e.instrumenttype === "") {
      tokenMap.set(e.symbol.replace(/-EQ$/, ""), e.token);
    }
  }

  // Resolve and update in-memory + DB
  for (const inst of needsToken) {
    const token = tokenMap.get(inst.symbol);
    if (!token) continue;
    inst.angel_one_token = token;
    await supabase.from("instruments").update({ angel_one_token: token }).eq("id", inst.id);
  }
}

// ---------------------------------------------------------------------------
// Previous-day OHLC refresh (pre-market, once per trading day)
// ---------------------------------------------------------------------------

function lastTradingDateIst(): string {
  const nowIstMs = Date.now() + 5.5 * 3600 * 1000;
  const dayOfWeek = new Date(nowIstMs).getUTCDay();
  const daysBack = dayOfWeek === 0 ? 2 : dayOfWeek === 1 ? 3 : 1;
  const lastTradingIstMs = nowIstMs - daysBack * 86400 * 1000;
  return new Date(lastTradingIstMs).toISOString().slice(0, 10);
}

function isTodayIst(ts: string | null): boolean {
  if (!ts) return false;
  const nowDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const tsDate = new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return nowDate === tsDate;
}

async function refreshPreviousDayOhlc(
  apiKey: string,
  jwtToken: string,
  instruments: DbInstrument[],
  supabase: ReturnType<typeof createServiceClient>,
): Promise<number> {
  const stale = instruments.filter((i) => i.angel_one_token && !isTodayIst(i.pdh_refreshed_at));
  if (stale.length === 0) return 0;

  const yDate = lastTradingDateIst();
  let updated = 0;

  for (const inst of stale) {
    try {
      const candles = await angelGetCandleData(apiKey, jwtToken, {
        exchange: EXCHANGE,
        symboltoken: inst.angel_one_token!,
        interval: "ONE_DAY",
        fromdate: `${yDate} 09:00`,
        todate: `${yDate} 15:30`,
      });

      if (candles.length === 0) continue;
      const [, , high, low, close, volume] = candles[candles.length - 1];
      if (!high) continue;

      await supabase.from("instruments").update({
        previous_day_high: high,
        previous_day_low: low,
        previous_close: close,
        prev_day_volume: typeof volume === "number" && volume > 0 ? volume : null,
        pdh_refreshed_at: new Date().toISOString(),
      }).eq("id", inst.id);

      updated++;
    } catch (err) {
      console.error(`[refresh-prices] PDH refresh failed for ${inst.symbol}:`, err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";
  const session = getMarketSessionStatus();

  let apiKey: string;
  let jwtToken: string;
  try {
    ({ apiKey, jwtToken } = await authenticateAngelOne());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const supabase = createServiceClient();

  await supabase.from("instruments").upsert(
    NIFTY200_SYMBOLS.map((symbol) => ({ symbol, exchange: EXCHANGE, name: symbol })),
    { onConflict: "symbol,exchange", ignoreDuplicates: true },
  );

  const { data: rawInstruments, error: instErr } = await supabase
    .from("instruments")
    .select("id,symbol,exchange,angel_one_token,previous_day_high,pdh_refreshed_at,session_high,session_low,or_date")
    .eq("exchange", EXCHANGE)
    .in("symbol", NIFTY200_SYMBOLS as unknown as string[]);

  if (instErr) return Response.json({ error: instErr.message }, { status: 500 });

  const instruments = (rawInstruments ?? []) as DbInstrument[];

  await resolveTokens(instruments, supabase);

  // Force mode: populate PDH + OR snapshot right now regardless of market hours.
  // Used to prime the reference levels when the system starts mid-day.
  if (force) {
    const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const pdhRefreshed = await refreshPreviousDayOhlc(apiKey, jwtToken, instruments, supabase);

    // Seed or_high/or_low from current session_high/session_low for any instrument
    // that doesn't yet have an OR snapshot for today.
    let orSeeded = 0;
    for (const inst of instruments) {
      if (inst.or_date === todayIst) continue;      // already have today's OR
      if (!inst.session_high || !inst.session_low) continue;
      await supabase.from("instruments").update({
        or_high: inst.session_high,
        or_low: inst.session_low,
        or_date: todayIst,
      }).eq("id", inst.id);
      orSeeded++;
    }

    return Response.json({ force: true, pdh_refreshed: pdhRefreshed, or_seeded: orSeeded });
  }

  if (!session.isOpen) {
    const pdhRefreshed = await refreshPreviousDayOhlc(apiKey, jwtToken, instruments, supabase);
    return Response.json({
      status: "Market closed, standing by.",
      market: EXCHANGE,
      weekday: session.weekday,
      ist_time: session.istTime,
      pdh_refreshed: pdhRefreshed,
    });
  }

  // -------------------------------------------------------------------------
  // Market hours: batch-fetch live OHLCV
  // -------------------------------------------------------------------------

  const tokens = instruments.map((i) => i.angel_one_token).filter(Boolean) as string[];

  if (tokens.length === 0) {
    return Response.json({ refreshed: 0, note: "Token resolution still in progress; retrying next invocation." });
  }

  // Angel One limits batch market data to 50 tokens per request
  const BATCH_SIZE = 50;
  let quotes: AngelQuote[] = [];
  try {
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE);
      quotes.push(...await angelGetMarketData(apiKey, jwtToken, EXCHANGE, batch));
    }
  } catch (err) {
    return Response.json({ error: `Market data fetch failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }

  const tokenToId = new Map(
    instruments.filter((i) => i.angel_one_token).map((i) => [i.angel_one_token!, i.id]),
  );

  const priceMarks: { instrument_id: string; price: number; source: string }[] = [];
  let updatedCount = 0;
  const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const inOrWindow = isOrBuildWindow();

  for (const quote of quotes) {
    const instrumentId = tokenToId.get(quote.symbolToken);
    if (!instrumentId || !quote.ltp || quote.ltp <= 0) continue;

    const rawVwap = quote.avgPrice ?? quote.averagePrice ?? null;
    const rawPrevClose = quote.close ?? null;
    const patch: Record<string, number | string> = { last_price: quote.ltp };

    if (typeof rawVwap === "number" && rawVwap > 0) patch.vwap = rawVwap;
    if (typeof rawPrevClose === "number" && rawPrevClose > 0) patch.previous_close = rawPrevClose;
    if (typeof quote.high === "number" && quote.high > 0) {
      patch.session_high = quote.high;
      patch.session_date = todayIst;
    }
    if (typeof quote.low === "number" && quote.low > 0) patch.session_low = quote.low;
    if (typeof quote.volume === "number" && quote.volume > 0) patch.session_volume = quote.volume;

    if (inOrWindow) {
      if (typeof quote.high === "number" && quote.high > 0) {
        patch.or_high = quote.high;
        patch.or_date = todayIst;
      }
      if (typeof quote.low === "number" && quote.low > 0) patch.or_low = quote.low;
    }

    await supabase.from("instruments").update(patch).eq("id", instrumentId);

    priceMarks.push({ instrument_id: instrumentId, price: quote.ltp, source: "angel_one" });

    await supabase
      .from("shadow_trades")
      .update({ current_price: quote.ltp })
      .eq("instrument_id", instrumentId)
      .eq("status", "open")
      .neq("current_price", quote.ltp);

    updatedCount++;
  }

  if (priceMarks.length > 0) {
    const { error: markError } = await supabase.from("price_marks").insert(priceMarks);
    if (markError) return Response.json({ error: markError.message }, { status: 500 });
  }

  return Response.json({ refreshed: updatedCount, source: "angel_one" });
});
