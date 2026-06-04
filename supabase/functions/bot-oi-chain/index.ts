// Requires Supabase secrets:
//   AngelOne_Apikey, AngelOne_SecretKey, AngelOne_ClientID, AngelOne_PIN

import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus, marketClosedResponse } from "../_shared/market-hours.ts";

const ANGEL_BASE = "https://apiconnect.angelone.in";
const NIFTY_TOKEN = "99926000";
const NIFTY_EXCHANGE = "NSE";
const NIFTY_SYMBOL = "Nifty 50";
const NFO_EXCHANGE = "NFO";
const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const SCRIP_CACHE_MS = 6 * 3600 * 1000;
const BATCH_SIZE = 50;

type ScripEntry = {
  token: string;
  symbol: string;
  exch_seg: string;
  instrumenttype: string;
  strike: string;
  optiontype: string;
  expiry: string;
};

type FullQuote = {
  symbolToken: string;
  tradingSymbol: string;
  opnInterest: number;
  ltp: number;
};

let cachedScrip: ScripEntry[] | null = null;
let cachedScripAt = 0;

function istDateKey(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function lastTradingDateIst(d: Date): string {
  const istMs = d.getTime() + 5.5 * 3600 * 1000;
  const day = new Date(istMs).getUTCDay();
  const back = day === 0 ? 2 : day === 1 ? 3 : 1;
  return new Date(istMs - back * 86400 * 1000).toISOString().slice(0, 10);
}

// Angel One weekly option symbols: NIFTY09JUN2623350CE
// expiry field in scrip master: "09JUN2026"
function nextWeeklyExpiry(from: Date): string {
  const d = new Date(from);
  const day = d.getUTCDay();
  const daysUntilThursday = (4 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilThursday);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getUTCMonth()];
  return `${dd}${mon}${d.getUTCFullYear()}`;
}

// "09JUN2026" → "2026-06-09"
function expiryToIso(expiry: string): string {
  const MON: Record<string, string> = {
    JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
    JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12",
  };
  return `${expiry.slice(5)}-${MON[expiry.slice(2, 5)]}-${expiry.slice(0, 2)}`;
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
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = stripped.toUpperCase().replace(/=/g, "");
    let bits = "";
    for (const ch of cleaned) {
      const v = alpha.indexOf(ch);
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
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[19] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

function hdrs(apiKey: string, jwt?: string): Record<string, string> {
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
  if (jwt) h["Authorization"] = `Bearer ${jwt}`;
  return h;
}

async function login(apiKey: string, clientId: string, pin: string, totp: string): Promise<string> {
  const resp = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST", headers: hdrs(apiKey),
    body: JSON.stringify({ clientcode: clientId, password: pin, totp }),
  });
  const data = await resp.json();
  if (!data?.status || !data?.data?.jwtToken) throw new Error(`Login failed: ${data?.message}`);
  return data.data.jwtToken as string;
}

async function authenticate(): Promise<{ apiKey: string; jwtToken: string }> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");
  if (!apiKey || !secretKey || !clientId || !pin) throw new Error("Missing Angel One secrets");
  return { apiKey, jwtToken: await login(apiKey, clientId, pin, await generateTotp(secretKey)) };
}

async function getScripMaster(): Promise<ScripEntry[]> {
  if (cachedScrip && Date.now() - cachedScripAt < SCRIP_CACHE_MS) return cachedScrip;
  const resp = await fetch(SCRIP_MASTER_URL);
  if (!resp.ok) throw new Error(`Scrip master failed: ${resp.status}`);
  cachedScrip = await resp.json() as ScripEntry[];
  cachedScripAt = Date.now();
  return cachedScrip;
}

async function fetchNiftyLtp(apiKey: string, jwt: string): Promise<number> {
  const resp = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/getLtpData`, {
    method: "POST", headers: hdrs(apiKey, jwt),
    body: JSON.stringify({ exchange: NIFTY_EXCHANGE, tradingsymbol: NIFTY_SYMBOL, symboltoken: NIFTY_TOKEN }),
  });
  const data = await resp.json();
  if (!data?.status || !Number.isFinite(Number(data?.data?.ltp))) throw new Error(`NIFTY LTP failed: ${data?.message}`);
  return Number(data.data.ltp);
}

async function fetchBatchFull(apiKey: string, jwt: string, tokens: string[]): Promise<FullQuote[]> {
  const resp = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
    method: "POST", headers: hdrs(apiKey, jwt),
    body: JSON.stringify({ mode: "FULL", exchangeTokens: { [NFO_EXCHANGE]: tokens } }),
  });
  const data = await resp.json();
  if (!data?.status || !Array.isArray(data?.data?.fetched)) throw new Error(`Batch quote failed: ${data?.message}`);
  return data.data.fetched as FullQuote[];
}

async function fetchNiftyYesterdayOhlc(
  apiKey: string, jwt: string, yDate: string,
): Promise<{ open: number; high: number; low: number; close: number } | null> {
  const resp = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: "POST", headers: hdrs(apiKey, jwt),
    body: JSON.stringify({
      exchange: NIFTY_EXCHANGE, symboltoken: NIFTY_TOKEN,
      interval: "ONE_DAY", fromdate: `${yDate} 09:00`, todate: `${yDate} 15:30`,
    }),
  });
  const data = await resp.json();
  const candles = data?.data as [string, number, number, number, number, number][] | undefined;
  if (!candles || candles.length === 0) return null;
  const [, open, high, low, close] = candles[candles.length - 1];
  if (!open || !high) return null;
  return { open, high, low, close };
}

Deno.serve(async () => {
  const sampledAt = new Date();
  const session = getMarketSessionStatus(sampledAt);
  if (!session.isOpen) return marketClosedResponse(sampledAt);

  try {
    const supabase = createServiceClient();
    const { apiKey, jwtToken } = await authenticate();

    // Fetch NIFTY spot price
    const underlyingLtp = await fetchNiftyLtp(apiKey, jwtToken);

    // Get all NIFTY weekly option tokens from scrip master.
    // Use nearest-upcoming-expiry approach (same as bot-premium-decay) so we're
    // not sensitive to the exact string format the scrip master uses for dates.
    const scripMaster = await getScripMaster();
    const nowIst = new Date(sampledAt.getTime() + 5.5 * 3600 * 1000);

    const allNiftyOptions = scripMaster.filter(
      (e) => e.exch_seg === "NFO" &&
             e.instrumenttype === "OPTIDX" &&
             e.symbol.startsWith("NIFTY") &&
             (e.symbol.endsWith("CE") || e.symbol.endsWith("PE")),
    );

    // Find the nearest upcoming expiry
    const expiryDates = new Map<string, Date>();
    for (const e of allNiftyOptions) {
      if (expiryDates.has(e.expiry)) continue;
      const d = new Date(e.expiry);
      if (Number.isFinite(d.getTime()) && d > nowIst) expiryDates.set(e.expiry, d);
    }
    const sorted = Array.from(expiryDates.entries()).sort((a, b) => a[1].getTime() - b[1].getTime());
    if (sorted.length === 0) {
      return Response.json({ ok: false, error: "No upcoming NIFTY option expiries in scrip master" }, { status: 200 });
    }
    const [nearestExpiryStr, nearestExpiryDate] = sorted[0];
    const expiry = nextWeeklyExpiry(sampledAt); // for logging only
    const optionTokens = allNiftyOptions.filter((e) => e.expiry === nearestExpiryStr);

    if (optionTokens.length === 0) {
      return Response.json({ ok: false, error: `No NIFTY option tokens for nearest expiry ${nearestExpiryStr}` }, { status: 200 });
    }

    const expiryDateIso = nearestExpiryDate.toISOString().slice(0, 10);

    // Batch-fetch FULL quotes (includes opnInterest)
    const tokens = optionTokens.map((e) => e.token);
    const allQuotes: FullQuote[] = [];
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE);
      const quotes = await fetchBatchFull(apiKey, jwtToken, batch);
      allQuotes.push(...quotes);
    }

    // Map token → scrip entry for strike/optiontype lookup
    const tokenMap = new Map(optionTokens.map((e) => [e.token, e]));

    // Group by strike
    type StrikeData = { ce_oi: number; pe_oi: number; ce_ltp: number | null; pe_ltp: number | null };
    const byStrike = new Map<number, StrikeData>();

    for (const q of allQuotes) {
      const entry = tokenMap.get(q.symbolToken);
      if (!entry) continue;
      const strike = Number(entry.strike) / 100; // scrip master stores strike * 100
      if (!Number.isFinite(strike) || strike <= 0) continue;

      if (!byStrike.has(strike)) {
        byStrike.set(strike, { ce_oi: 0, pe_oi: 0, ce_ltp: null, pe_ltp: null });
      }
      const sd = byStrike.get(strike)!;
      const oi = Number(q.opnInterest) || 0;
      const ltp = Number.isFinite(q.ltp) ? q.ltp : null;

      if (entry.symbol.endsWith("CE")) { sd.ce_oi = oi; sd.ce_ltp = ltp; }
      else if (entry.symbol.endsWith("PE")) { sd.pe_oi = oi; sd.pe_ltp = ltp; }
    }

    const sessionDate = istDateKey(sampledAt);

    const rows = Array.from(byStrike.entries()).map(([strike, d]) => ({
      sampled_at: sampledAt.toISOString(),
      session_date: sessionDate,
      expiry_date: expiryDateIso,
      strike,
      ce_oi: d.ce_oi,
      pe_oi: d.pe_oi,
      ce_ltp: d.ce_ltp,
      pe_ltp: d.pe_ltp,
      underlying_ltp: underlyingLtp,
    }));

    if (rows.length > 0) {
      const { error: insertErr } = await supabase.from("bot_nifty_oi_chain").insert(rows);
      if (insertErr) throw new Error(`OI insert failed: ${insertErr.message}`);
    }

    // Purge old sessions
    await supabase.from("bot_nifty_oi_chain").delete().lt("session_date", sessionDate);

    // Refresh NIFTY yesterday OHLC + current LTP in bot_settings (OHLC once per session)
    const { data: settings } = await supabase
      .from("bot_settings").select("nifty_previous_date").eq("id", 1).maybeSingle();
    const storedDate = (settings as { nifty_previous_date: string | null } | null)?.nifty_previous_date;

    const settingsPatch: Record<string, unknown> = { nifty_current_ltp: underlyingLtp };

    if (storedDate !== sessionDate) {
      const yDate = lastTradingDateIst(sampledAt);
      const ohlc = await fetchNiftyYesterdayOhlc(apiKey, jwtToken, yDate);
      if (ohlc) {
        settingsPatch.nifty_previous_open = ohlc.open;
        settingsPatch.nifty_previous_high = ohlc.high;
        settingsPatch.nifty_previous_low = ohlc.low;
        settingsPatch.nifty_previous_close = ohlc.close;
        settingsPatch.nifty_previous_date = sessionDate;
      }
    }

    const { error: settingsErr } = await supabase
      .from("bot_settings")
      .update(settingsPatch)
      .eq("id", 1);
    if (settingsErr) console.error("[bot-oi-chain] settings update failed:", settingsErr.message);

    return Response.json({ ok: true, strikes: rows.length, expiry: nearestExpiryStr, underlying_ltp: underlyingLtp, tokens_found: optionTokens.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bot-oi-chain]", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
});
