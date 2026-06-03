// Requires Supabase secrets:
//   AngelOne_Apikey, AngelOne_SecretKey, AngelOne_ClientID, AngelOne_PIN

import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus, marketClosedResponse } from "../_shared/market-hours.ts";

const ANGEL_BASE = "https://apiconnect.angelone.in";
const NIFTY_TOKEN = "99926000";
const NIFTY_EXCHANGE = "NSE";
const NIFTY_SYMBOL = "Nifty 50";

// Angel One optionGreek endpoint — returns full chain per expiry with OI per strike.
// Response row shape: { strikePrice, optionType: "CE"|"PE", opnInterest, ltp, ... }
type OptionGreekRow = {
  strikePrice: string;
  optionType: "CE" | "PE";
  opnInterest: number;
  chgInOpnInterest: number;
  ltp: number;
};

// Next Thursday on or after today (NSE weekly expiry convention).
function nextWeeklyExpiry(from: Date): string {
  const d = new Date(from);
  const day = d.getUTCDay();
  const daysUntilThursday = (4 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilThursday);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getUTCMonth()];
  return `${dd}${mon}${d.getUTCFullYear()}`;
}

function istDateKey(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function lastTradingDateIst(d: Date): string {
  const nowIstMs = d.getTime() + 5.5 * 3600 * 1000;
  const dayOfWeek = new Date(nowIstMs).getUTCDay();
  const daysBack = dayOfWeek === 0 ? 2 : dayOfWeek === 1 ? 3 : 1;
  return new Date(nowIstMs - daysBack * 86400 * 1000).toISOString().slice(0, 10);
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

function headers(apiKey: string, jwt?: string): Record<string, string> {
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
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ clientcode: clientId, password: pin, totp }),
  });
  const data = await resp.json();
  if (!data?.status || !data?.data?.jwtToken) {
    throw new Error(`Angel One login failed: ${data?.message ?? JSON.stringify(data)}`);
  }
  return data.data.jwtToken as string;
}

async function authenticate(): Promise<{ apiKey: string; jwtToken: string }> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");
  if (!apiKey || !secretKey || !clientId || !pin) {
    throw new Error("Missing secrets: AngelOne_Apikey, AngelOne_SecretKey, AngelOne_ClientID, AngelOne_PIN");
  }
  return { apiKey, jwtToken: await login(apiKey, clientId, pin, await generateTotp(secretKey)) };
}

async function fetchNiftyLtp(apiKey: string, jwt: string): Promise<number> {
  const resp = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/getLtpData`, {
    method: "POST",
    headers: headers(apiKey, jwt),
    body: JSON.stringify({ exchange: NIFTY_EXCHANGE, tradingsymbol: NIFTY_SYMBOL, symboltoken: NIFTY_TOKEN }),
  });
  const data = await resp.json();
  if (!data?.status || !Number.isFinite(Number(data?.data?.ltp))) {
    throw new Error(`NIFTY LTP failed: ${data?.message ?? JSON.stringify(data)}`);
  }
  return Number(data.data.ltp);
}

async function fetchOptionGreeks(apiKey: string, jwt: string, expiry: string): Promise<OptionGreekRow[]> {
  const resp = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/marketData/v1/getOptionGreeks`, {
    method: "POST",
    headers: headers(apiKey, jwt),
    body: JSON.stringify({ name: "NIFTY", expirydate: expiry }),
  });
  const data = await resp.json();
  if (!data?.status || !Array.isArray(data?.data)) {
    throw new Error(`optionGreek failed: ${data?.message ?? JSON.stringify(data)}`);
  }
  return data.data as OptionGreekRow[];
}

async function fetchNiftyYesterdayOhlc(
  apiKey: string,
  jwt: string,
  yDate: string,
): Promise<{ open: number; high: number; low: number; close: number } | null> {
  const resp = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: "POST",
    headers: headers(apiKey, jwt),
    body: JSON.stringify({
      exchange: NIFTY_EXCHANGE,
      symboltoken: NIFTY_TOKEN,
      interval: "ONE_DAY",
      fromdate: `${yDate} 09:00`,
      todate: `${yDate} 15:30`,
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

    // Fetch full option chain OI
    const expiry = nextWeeklyExpiry(sampledAt);
    const greeks = await fetchOptionGreeks(apiKey, jwtToken, expiry);

    // Group by strike → { ce_oi, pe_oi, ce_ltp, pe_ltp }
    type StrikeData = { ce_oi: number; pe_oi: number; ce_ltp: number | null; pe_ltp: number | null };
    const byStrike = new Map<number, StrikeData>();
    for (const row of greeks) {
      const strike = Number(row.strikePrice);
      if (!Number.isFinite(strike) || strike <= 0) continue;
      if (!byStrike.has(strike)) {
        byStrike.set(strike, { ce_oi: 0, pe_oi: 0, ce_ltp: null, pe_ltp: null });
      }
      const entry = byStrike.get(strike)!;
      if (row.optionType === "CE") {
        entry.ce_oi = Number(row.opnInterest) || 0;
        entry.ce_ltp = Number.isFinite(row.ltp) ? row.ltp : null;
      } else if (row.optionType === "PE") {
        entry.pe_oi = Number(row.opnInterest) || 0;
        entry.pe_ltp = Number.isFinite(row.ltp) ? row.ltp : null;
      }
    }

    const sessionDate = istDateKey(sampledAt);
    // Convert "05JUN2026" → "2026-06-05"
    const MON: Record<string, string> = {
      JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
      JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12",
    };
    const expiryDateIso = `${expiry.slice(5)}-${MON[expiry.slice(2,5)]}-${expiry.slice(0,2)}`;

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
      if (insertErr) throw new Error(`OI chain insert failed: ${insertErr.message}`);
    }

    // Purge rows from sessions older than today to cap table size
    const { error: purgeErr } = await supabase
      .from("bot_nifty_oi_chain")
      .delete()
      .lt("session_date", sessionDate);
    if (purgeErr) console.warn("[bot-oi-chain] purge failed:", purgeErr.message);

    // Refresh NIFTY yesterday OHLC in bot_settings once per session date
    const { data: settings } = await supabase
      .from("bot_settings")
      .select("nifty_previous_date")
      .eq("id", 1)
      .single();

    const storedDate = (settings as { nifty_previous_date: string | null } | null)?.nifty_previous_date;
    if (storedDate !== sessionDate) {
      const yDate = lastTradingDateIst(sampledAt);
      const ohlc = await fetchNiftyYesterdayOhlc(apiKey, jwtToken, yDate);
      if (ohlc) {
        await supabase.from("bot_settings").update({
          nifty_previous_open: ohlc.open,
          nifty_previous_high: ohlc.high,
          nifty_previous_low: ohlc.low,
          nifty_previous_close: ohlc.close,
          nifty_previous_date: sessionDate,
        }).eq("id", 1);
      }
    }

    return Response.json({ ok: true, strikes: rows.length, expiry, underlying_ltp: underlyingLtp });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
});
