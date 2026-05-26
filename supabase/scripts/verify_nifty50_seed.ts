import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.4";

const ANGEL_BASE = "https://apiconnect.angelbroking.com";
const EXCHANGE = "NSE";

const NIFTY_50_SYMBOLS = [
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

type InstrumentRow = {
  id: string;
  symbol: string;
  angel_one_token: string | null;
};

type SearchScripResult = {
  exchange?: string;
  tradingsymbol?: string;
  symbol?: string;
  symboltoken?: string;
};

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function generateTotp(secret: string): Promise<string> {
  const stripped = secret.replace(/[-\s]/g, "");
  const isHex = /^[0-9a-fA-F]+$/.test(stripped) && stripped.length % 2 === 0;

  let keyBytes: Uint8Array;
  if (isHex) {
    keyBytes = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < keyBytes.length; i++) {
      keyBytes[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = stripped.toUpperCase().replace(/=/g, "");
    let bits = "";
    for (const ch of cleaned) {
      const index = alphabet.indexOf(ch);
      bits += (index === -1 ? 0 : index).toString(2).padStart(5, "0");
    }

    keyBytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < keyBytes.length; i++) {
      keyBytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
  }

  const counter = Math.floor(Date.now() / 1000 / 30);
  const message = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = value & 0xff;
    value = Math.floor(value / 256);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));

  const offset = signature[19] & 0x0f;
  const code = ((signature[offset] & 0x7f) << 24)
    | ((signature[offset + 1] & 0xff) << 16)
    | ((signature[offset + 2] & 0xff) << 8)
    | (signature[offset + 3] & 0xff);

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

  if (jwtToken) {
    headers.Authorization = `Bearer ${jwtToken}`;
  }

  return headers;
}

async function angelLogin(apiKey: string, clientId: string, pin: string, totp: string): Promise<string> {
  const response = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST",
    headers: angelHeaders(apiKey),
    body: JSON.stringify({
      clientcode: clientId,
      password: pin,
      totp,
    }),
  });

  const data = await response.json();
  if (!data?.status || !data?.data?.jwtToken) {
    throw new Error(`Angel login failed: ${data?.message ?? JSON.stringify(data)}`);
  }

  return data.data.jwtToken as string;
}

async function searchScrip(apiKey: string, jwtToken: string, symbol: string): Promise<string | null> {
  const attempts = [`${symbol}-EQ`, symbol];

  for (const query of attempts) {
    const response = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/searchScrip`, {
      method: "POST",
      headers: angelHeaders(apiKey, jwtToken),
      body: JSON.stringify({
        exchange: EXCHANGE,
        searchscrip: query,
      }),
    });

    const data = await response.json();
    const rows = (data?.data ?? []) as SearchScripResult[];

    const exact = rows.find((row) => row.exchange === EXCHANGE && row.tradingsymbol === `${symbol}-EQ` && row.symboltoken);
    if (exact?.symboltoken) {
      return exact.symboltoken;
    }

    const fallback = rows.find((row) => row.exchange === EXCHANGE && row.symboltoken);
    if (fallback?.symboltoken) {
      return fallback.symboltoken;
    }
  }

  return null;
}

async function fetchInstruments(supabase: any): Promise<InstrumentRow[]> {
  const { data, error } = await supabase
    .from("instruments")
    .select("id,symbol,angel_one_token")
    .eq("exchange", EXCHANGE)
    .in("symbol", [...NIFTY_50_SYMBOLS]);

  if (error) {
    throw new Error(`Failed to read instruments: ${error.message}`);
  }

  return (data ?? []) as InstrumentRow[];
}

async function ensureRowsExist(supabase: any, existingRows: InstrumentRow[]): Promise<void> {
  const existingSymbols = new Set(existingRows.map((row) => row.symbol));
  const missingSymbols = NIFTY_50_SYMBOLS.filter((symbol) => !existingSymbols.has(symbol));

  if (missingSymbols.length === 0) {
    return;
  }

  const payload = missingSymbols.map((symbol) => ({ symbol, exchange: EXCHANGE, name: symbol }));
  const { error } = await supabase
    .from("instruments")
    .upsert(payload, { onConflict: "symbol,exchange", ignoreDuplicates: true });

  if (error) {
    throw new Error(`Failed to seed missing instruments: ${error.message}`);
  }

  console.log(`Seeded ${missingSymbols.length} missing Nifty 50 instruments.`);
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  let instruments = await fetchInstruments(supabase);
  await ensureRowsExist(supabase, instruments);
  instruments = await fetchInstruments(supabase);

  const missingTokenRows = instruments.filter((row) => !row.angel_one_token);

  if (missingTokenRows.length === 0) {
    console.log("Verified: all Nifty 50 instruments exist with non-null angel_one_token.");
    return;
  }

  const apiKey = requireEnv("AngelOne_Apikey");
  const secretKey = requireEnv("AngelOne_SecretKey");
  const clientId = requireEnv("AngelOne_ClientID");
  const pin = requireEnv("AngelOne_PIN");

  const totp = await generateTotp(secretKey);
  const jwtToken = await angelLogin(apiKey, clientId, pin, totp);

  for (const row of missingTokenRows) {
    const token = await searchScrip(apiKey, jwtToken, row.symbol);
    if (!token) {
      console.warn(`No searchScrip token match for ${row.symbol}`);
      continue;
    }

    const { error } = await supabase
      .from("instruments")
      .update({ angel_one_token: token })
      .eq("id", row.id);

    if (error) {
      throw new Error(`Failed to update token for ${row.symbol}: ${error.message}`);
    }

    console.log(`Updated ${row.symbol} -> ${token}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const postUpdate = await fetchInstruments(supabase);
  const unresolved = postUpdate.filter((row) => !row.angel_one_token).map((row) => row.symbol);

  if (unresolved.length > 0) {
    throw new Error(`Unresolved Nifty 50 symbols without angel_one_token: ${unresolved.join(", ")}`);
  }

  console.log("Verified: all Nifty 50 instruments exist with non-null angel_one_token.");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
