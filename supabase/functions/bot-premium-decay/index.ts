import { getMarketSessionStatus, marketClosedResponse } from "../_shared/market-hours.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  buildPremiumDecayPoint,
  PREMIUM_DECAY_SERIES_KEY,
  selectNearestAtmOptionPair,
  type AngelInstrument,
  type PremiumDecayBaseline,
} from "./premium-decay.ts";

const ANGEL_BASE = "https://apiconnect.angelone.in";
const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const NIFTY_INDEX = {
  exchange: "NSE",
  tradingSymbol: "Nifty 50",
  symbolToken: "99926000",
};
const MAX_ANGEL_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

async function readJsonResponse(response: Response, operation: string) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${operation} returned non-JSON HTTP ${response.status}: ${body.slice(0, 120)}`);
  }
}

async function withAngelRetry<T>(operation: string, request: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ANGEL_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ANGEL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }

  throw new Error(`${operation} failed after ${MAX_ANGEL_ATTEMPTS} attempts: ${
    lastError instanceof Error ? lastError.message : String(lastError)
  }`);
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
      if (value === -1) throw new Error("AngelOne_SecretKey is not valid hex or base32");
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
  const key = await crypto.subtle.importKey("raw", keyData.buffer, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[19] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);

  return (code % 1_000_000).toString().padStart(6, "0");
}

function angelHeaders(apiKey: string, jwtToken?: string): Record<string, string> {
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

async function angelLogin(apiKey: string, clientId: string, pin: string, totp: string): Promise<string> {
  return await withAngelRetry("Angel One login", async () => {
    const response = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: "POST",
      headers: angelHeaders(apiKey),
      body: JSON.stringify({ clientcode: clientId, password: pin, totp }),
    });
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
  return await withAngelRetry(`Angel One LTP for ${tradingSymbol}`, async () => {
    const response = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/getLtpData`, {
      method: "POST",
      headers: angelHeaders(apiKey, jwtToken),
      body: JSON.stringify({ exchange, tradingsymbol: tradingSymbol, symboltoken: symbolToken }),
    });
    const data = await readJsonResponse(response, `Angel One LTP for ${tradingSymbol}`);
    if (!data?.status || !Number.isFinite(Number(data?.data?.ltp))) {
      throw new Error(data?.message ?? JSON.stringify(data));
    }
    return Number(data.data.ltp);
  });
}

async function authenticate(): Promise<{ apiKey: string; jwtToken: string }> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");
  if (!apiKey || !secretKey || !clientId || !pin) {
    throw new Error("Missing Supabase secrets: AngelOne_Apikey, AngelOne_SecretKey, AngelOne_ClientID, AngelOne_PIN");
  }
  return { apiKey, jwtToken: await angelLogin(apiKey, clientId, pin, await generateTotp(secretKey)) };
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

    const scripResponse = await fetch(SCRIP_MASTER_URL);
    if (!scripResponse.ok) throw new Error(`Angel One scrip master failed: HTTP ${scripResponse.status}`);
    const pair = selectNearestAtmOptionPair(await scripResponse.json() as AngelInstrument[], underlyingLtp, sampledAt);
    const [ceLtp, peLtp] = await Promise.all([
      angelLtp(apiKey, jwtToken, "NFO", pair.ce.symbol, pair.ce.token),
      angelLtp(apiKey, jwtToken, "NFO", pair.pe.symbol, pair.pe.token),
    ]);

    const startOfSession = `${session.istDate}T03:45:00.000Z`;
    const { data: baseline, error: baselineError } = await supabase
      .from("bot_premium_decay_points")
      .select("ce_ltp, pe_ltp")
      .eq("series_key", PREMIUM_DECAY_SERIES_KEY)
      .gte("sampled_at", startOfSession)
      .order("sampled_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (baselineError) throw new Error(`Could not read premium decay baseline: ${baselineError.message}`);

    const point = buildPremiumDecayPoint(
      sampledAt,
      pair,
      underlyingLtp,
      ceLtp,
      peLtp,
      baseline as PremiumDecayBaseline | null,
    );
    const { error: insertError } = await supabase.from("bot_premium_decay_points").insert(point);
    if (insertError) throw new Error(`Could not insert premium decay point: ${insertError.message}`);

    return Response.json({ ok: true, point });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
});
