const ANGEL_BASE = "https://apiconnect.angelone.in";

export type AngelQuote = {
  symbolToken: string;
  tradingSymbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  ltp: number;
  volume: number;
  avgPrice?: number;
  averagePrice?: number;
};

export type AngelCandle = [string, number, number, number, number, number];

export type CandleDataRequest = {
  exchange: string;
  symboltoken: string;
  interval: string;
  fromdate: string;
  todate: string;
};

function angelHeaders(apiKey: string, jwtToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
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

export async function generateTotp(secret: string): Promise<string> {
  const stripped = secret.replace(/[-\s]/g, "");
  const isHex = /^[0-9a-fA-F]+$/.test(stripped) && stripped.length % 2 === 0;

  let keyBytes: Uint8Array;
  if (isHex) {
    keyBytes = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < keyBytes.length; i += 1) {
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
    for (let i = 0; i < keyBytes.length; i += 1) {
      keyBytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
  }

  const counter = Math.floor(Date.now() / 1000 / 30);
  const message = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i -= 1) {
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

export async function angelLogin(apiKey: string, clientId: string, pin: string, totp: string): Promise<string> {
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
    throw new Error(`Angel One login failed: ${data?.message ?? JSON.stringify(data)}`);
  }

  return data.data.jwtToken as string;
}

export async function authenticateAngelOne(): Promise<{ apiKey: string; jwtToken: string }> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");

  if (!apiKey || !secretKey || !clientId || !pin) {
    throw new Error(
      "Missing Supabase secrets: AngelOne_Apikey, AngelOne_SecretKey, AngelOne_ClientID, AngelOne_PIN",
    );
  }

  const totp = await generateTotp(secretKey);
  const jwtToken = await angelLogin(apiKey, clientId, pin, totp);

  return { apiKey, jwtToken };
}

export async function angelGetMarketData(
  apiKey: string,
  jwtToken: string,
  exchange: string,
  tokens: string[],
): Promise<AngelQuote[]> {
  const response = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
    method: "POST",
    headers: angelHeaders(apiKey, jwtToken),
    body: JSON.stringify({
      mode: "FULL",
      exchangeTokens: { [exchange]: tokens },
    }),
  });

  const data = await response.json();
  return (data?.data?.fetched ?? []) as AngelQuote[];
}

export async function angelGetCandleData(
  apiKey: string,
  jwtToken: string,
  params: CandleDataRequest,
): Promise<AngelCandle[]> {
  const response = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: "POST",
    headers: angelHeaders(apiKey, jwtToken),
    body: JSON.stringify(params),
  });

  const data = await response.json();
  return (data?.data ?? []) as AngelCandle[];
}
