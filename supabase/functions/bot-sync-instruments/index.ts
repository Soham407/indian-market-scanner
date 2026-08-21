import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus } from "../_shared/market-hours.ts";

const SCRIP_MASTER_URLS = [
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
];

function parseAngelExpiry(expiry: string): string | null {
  const normalized = expiry.trim().toUpperCase();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const parsed = new Date(
    `${normalized.slice(2, 5)} ${normalized.slice(0, 2)}, ${normalized.slice(5)} UTC`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalizeStrike(strike: string): number {
  const rawStrike = Number(strike);
  return Number.isFinite(rawStrike) ? rawStrike / 100 : 0;
}

Deno.serve(async () => {
  const supabase = createServiceClient();
  const now = new Date();
  const session = getMarketSessionStatus(now);
  const today = session.istDate;

  let rawInstruments: any[] = [];
  let lastError: unknown;

  for (const url of SCRIP_MASTER_URLS) {
    try {
      console.log(`[bot-sync-instruments] Fetching master from ${url}...`);
      const resp = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (resp.ok) {
        rawInstruments = await resp.json();
        break;
      }
    } catch (e) {
      lastError = e;
    }
  }

  if (!rawInstruments.length) {
    return new Response(
      JSON.stringify({ ok: false, error: `Failed to download master: ${lastError}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Filter only active NIFTY OPTIDX for current and next 2 weekly expiries
  const activeNifty = rawInstruments
    .filter((inst) =>
      inst.exch_seg === "NFO" &&
      inst.instrumenttype === "OPTIDX" &&
      inst.name === "NIFTY"
    )
    .map((inst) => {
      const expiryDate = parseAngelExpiry(inst.expiry);
      const optionType = inst.symbol.endsWith("CE")
        ? "CE"
        : inst.symbol.endsWith("PE")
        ? "PE"
        : null;

      if (!expiryDate || !optionType || expiryDate < today) return null;

      return {
        exchange: "NFO",
        instrument_type: "OPTIDX",
        name: "NIFTY",
        symbol: inst.symbol,
        token: String(inst.token),
        strike: normalizeStrike(inst.strike),
        option_type: optionType,
        expiry_date: expiryDate,
        synced_at: new Date().toISOString(),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  console.log(`[bot-sync-instruments] Extracted ${activeNifty.length} active NIFTY contracts for today ${today}`);

  // Upsert in batches of 100 into bot_active_instruments
  let upserted = 0;
  for (let i = 0; i < activeNifty.length; i += 100) {
    const chunk = activeNifty.slice(i, i + 100);
    const { error } = await supabase
      .from("bot_active_instruments")
      .upsert(chunk, { onConflict: "token" });
    if (!error) upserted += chunk.length;
  }

  return new Response(
    JSON.stringify({ ok: true, activeContractsCount: activeNifty.length, upsertedCount: upserted }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
