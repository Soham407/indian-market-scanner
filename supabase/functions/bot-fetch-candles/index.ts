import { createServiceClient } from "../_shared/supabase.ts";
import {
  getMarketSessionStatus,
  marketClosedResponse,
} from "../_shared/market-hours.ts";
import {
  angelGetCandleData,
  authenticateAngelOne,
} from "../_shared/angel-one.ts";
import {
  selectLatestAngelCandle,
  timeframeToAngelInterval,
  toBotCandleUpsertRow,
  type CandleTimeframe,
} from "./candles.ts";

const EXCHANGE = "NSE";
const SOURCE = "bot-fetch-candles";
const TIMEFRAMES: CandleTimeframe[] = ["1m", "5m"];
const LOOKBACK_MINUTES: Record<CandleTimeframe, number> = {
  "1m": 30,
  "5m": 150,
};

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

function formatIstDateTime(value: Date): string {
  const ist = new Date(value.getTime() + 330 * 60 * 1000);
  const date = ist.toISOString().slice(0, 10);
  const hours = String(ist.getUTCHours()).padStart(2, "0");
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${date} ${hours}:${minutes}`;
}

function buildCandleWindow(timeframe: CandleTimeframe, now = new Date()): { fromdate: string; todate: string } {
  const toDate = formatIstDateTime(now);
  const fromDate = formatIstDateTime(
    new Date(now.getTime() - LOOKBACK_MINUTES[timeframe] * 60 * 1000),
  );

  return {
    fromdate: fromDate,
    todate: toDate,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function logIncident(
  supabase: ReturnType<typeof createServiceClient>,
  instrument: Pick<InstrumentRow, "id" | "symbol">,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("bot_incidents").insert({
    severity: "warn",
    source: SOURCE,
    message,
    context: {
      instrument_id: instrument.id,
      symbol: instrument.symbol,
      ...context,
    },
  });

  if (error) {
    console.error(`[${SOURCE}] failed to write incident for ${instrument.symbol}: ${error.message}`);
  }
}

Deno.serve(async () => {
  if (!getMarketSessionStatus().isOpen) {
    return marketClosedResponse();
  }

  let apiKey: string;
  let jwtToken: string;

  try {
    ({ apiKey, jwtToken } = await authenticateAngelOne());
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }

  const supabase = createServiceClient();

  await supabase.from("instruments").upsert(
    NIFTY_50_SYMBOLS.map((symbol) => ({ symbol, exchange: EXCHANGE, name: symbol })),
    { onConflict: "symbol,exchange", ignoreDuplicates: true },
  );

  const { data, error } = await supabase
    .from("instruments")
    .select("id,symbol,angel_one_token")
    .eq("exchange", EXCHANGE)
    .in("symbol", [...NIFTY_50_SYMBOLS]);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const instruments = (data ?? []) as InstrumentRow[];
  let upserted = 0;
  let incidents = 0;

  for (const instrument of instruments) {
    if (!instrument.angel_one_token) {
      incidents += 1;
      await logIncident(
        supabase,
        instrument,
        `Missing Angel One token for ${instrument.symbol}`,
        { reason: "missing_angel_one_token" },
      );
      continue;
    }

    for (const timeframe of TIMEFRAMES) {
      try {
        const window = buildCandleWindow(timeframe);
        const candles = await angelGetCandleData(apiKey, jwtToken, {
          exchange: EXCHANGE,
          symboltoken: instrument.angel_one_token,
          interval: timeframeToAngelInterval(timeframe),
          fromdate: window.fromdate,
          todate: window.todate,
        });

        const latest = selectLatestAngelCandle(candles);
        if (!latest) {
          throw new Error(`No ${timeframe} candle returned`);
        }

        const { error: upsertError } = await supabase
          .from("bot_candles")
          .upsert(toBotCandleUpsertRow(instrument.id, timeframe, latest), {
            onConflict: "instrument_id,timeframe,candle_open_at",
          });

        if (upsertError) {
          throw new Error(upsertError.message);
        }

        upserted += 1;
      } catch (err) {
        incidents += 1;
        console.error(`[${SOURCE}] ${instrument.symbol} ${timeframe} failed:`, err);
        await logIncident(
          supabase,
          instrument,
          `Candle ingest failed for ${instrument.symbol}`,
          {
            timeframe,
            error: errorMessage(err),
          },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  return Response.json({
    status: "ok",
    instruments: instruments.length,
    upserted,
    incidents,
  });
});
