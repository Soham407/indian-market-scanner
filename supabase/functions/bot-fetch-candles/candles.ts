export type CandleTimeframe = "1m" | "5m";

export type AngelCandle = [string, number, number, number, number, number];

export type BotCandleUpsertRow = {
  instrument_id: string;
  timeframe: CandleTimeframe;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  candle_open_at: string;
  source: "angel_one";
};

export function timeframeToAngelInterval(timeframe: CandleTimeframe): "ONE_MINUTE" | "FIVE_MINUTE" {
  return timeframe === "1m" ? "ONE_MINUTE" : "FIVE_MINUTE";
}

export function normalizeAngelCandleOpenAt(value: string): string {
  const trimmed = value.trim();
  const withTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(" ", "T")}:00+05:30`;

  const parsed = new Date(withTimezone);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid candle timestamp: ${value}`);
  }

  return parsed.toISOString();
}

export function selectLatestAngelCandle(candles: AngelCandle[]): AngelCandle | null {
  if (candles.length === 0) {
    return null;
  }

  let latest = candles[0];
  let latestTs = new Date(normalizeAngelCandleOpenAt(latest[0])).getTime();

  for (let i = 1; i < candles.length; i += 1) {
    const candidate = candles[i];
    const candidateTs = new Date(normalizeAngelCandleOpenAt(candidate[0])).getTime();
    if (candidateTs > latestTs) {
      latest = candidate;
      latestTs = candidateTs;
    }
  }

  return latest;
}

export function toBotCandleUpsertRow(
  instrumentId: string,
  timeframe: CandleTimeframe,
  candle: AngelCandle,
): BotCandleUpsertRow {
  const [candleOpenAt, open, high, low, close, volume] = candle;

  return {
    instrument_id: instrumentId,
    timeframe,
    open,
    high,
    low,
    close,
    volume,
    candle_open_at: normalizeAngelCandleOpenAt(candleOpenAt),
    source: "angel_one",
  };
}
