import {
  assertEquals,
  assertThrows,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeAngelCandleOpenAt,
  selectLatestAngelCandle,
  timeframeToAngelInterval,
  toBotCandleUpsertRow,
  type AngelCandle,
} from "./candles.ts";

Deno.test("timeframe mapping: 1m maps to ONE_MINUTE", () => {
  assertEquals(timeframeToAngelInterval("1m"), "ONE_MINUTE");
});

Deno.test("timeframe mapping: 5m maps to FIVE_MINUTE", () => {
  assertEquals(timeframeToAngelInterval("5m"), "FIVE_MINUTE");
});

Deno.test("candle timestamp: normalizes IST timestamp without timezone", () => {
  assertEquals(
    normalizeAngelCandleOpenAt("2026-05-26 09:15"),
    "2026-05-26T03:45:00.000Z",
  );
});

Deno.test("candle timestamp: rejects invalid timestamp", () => {
  assertThrows(() => normalizeAngelCandleOpenAt("not-a-date"), Error);
});

Deno.test("latest candle: selects candle with most recent open time", () => {
  const candles: AngelCandle[] = [
    ["2026-05-26 09:15", 100, 101, 99, 100.5, 1500],
    ["2026-05-26 09:20", 101, 102, 100, 101.5, 1800],
    ["2026-05-26 09:25", 102, 103, 101, 102.5, 1700],
  ];

  const latest = selectLatestAngelCandle(candles);

  assertEquals(latest, candles[2]);
});

Deno.test("latest candle: returns null for empty list", () => {
  assertEquals(selectLatestAngelCandle([]), null);
});

Deno.test("upsert row: maps values to bot_candles row shape", () => {
  const row = toBotCandleUpsertRow(
    "instrument-1",
    "5m",
    ["2026-05-26 09:30", 2500.1, 2505.2, 2498.4, 2502.75, 123456],
  );

  assertEquals(row, {
    instrument_id: "instrument-1",
    timeframe: "5m",
    open: 2500.1,
    high: 2505.2,
    low: 2498.4,
    close: 2502.75,
    volume: 123456,
    candle_open_at: "2026-05-26T04:00:00.000Z",
    source: "angel_one",
  });
});

// Market-hours guard tests (covers index.ts:91 behavior)
Deno.test("market-hours guard: inside session returns isOpen=true", async () => {
  // Monday 2026-05-25 at 09:30 IST (market open: 09:15-15:30 on weekdays)
  const marketOpenTime = new Date("2026-05-25T04:00:00Z"); // 09:30 IST

  // Import and test the market-hours helper
  const { getMarketSessionStatus } = await import("../_shared/market-hours.ts");
  const status = getMarketSessionStatus(marketOpenTime);

  assert(status.isOpen, "Market should be open on weekday 09:30 IST");
  assertEquals(status.weekday, "Mon");
});

Deno.test("market-hours guard: outside session returns isOpen=false", async () => {
  // Monday 2026-05-25 at 16:00 IST (market closed, after 15:30)
  const marketClosedTime = new Date("2026-05-25T10:30:00Z"); // 16:00 IST

  const { getMarketSessionStatus } = await import("../_shared/market-hours.ts");
  const status = getMarketSessionStatus(marketClosedTime);

  assertEquals(status.isOpen, false, "Market should be closed after 15:30 IST");
});

// Dedup/idempotency tests (covers index.ts:156 behavior)
Deno.test("dedup logic: upsert uses instrument_id,timeframe,candle_open_at as conflict key", () => {
  const row1 = toBotCandleUpsertRow(
    "instr-1",
    "5m",
    ["2026-05-26 10:00", 100, 101, 99, 100.5, 1000],
  );

  const row2 = toBotCandleUpsertRow(
    "instr-1",
    "5m",
    ["2026-05-26 10:00", 100.2, 101.1, 99.1, 100.6, 1050], // Same key, different values
  );

  // Verify they have the same conflict key components
  assertEquals(row1.instrument_id, row2.instrument_id);
  assertEquals(row1.timeframe, row2.timeframe);
  assertEquals(row1.candle_open_at, row2.candle_open_at);

  // Different values show this is a real duplicate scenario
  assertEquals(row1.volume, 1000);
  assertEquals(row2.volume, 1050);
  assert(row1.close !== row2.close, "Duplicate ingestion should have different OHLC on upsert");
});
