import {
  assertEquals,
  assertThrows,
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
