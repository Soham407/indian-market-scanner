import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPremiumDecayPoint,
  PREMIUM_DECAY_BAND_SERIES_KEY,
  PREMIUM_DECAY_SERIES_KEY,
  selectAtmBandPairs,
  selectNearestAtmOptionPair,
  type AngelInstrument,
} from "./premium-decay.ts";

function contract(symbol: string, strike: string, expiry = "02JUN2026"): AngelInstrument {
  return {
    token: symbol,
    symbol,
    name: "NIFTY",
    expiry,
    strike,
    exch_seg: "NFO",
    instrumenttype: "OPTIDX",
  };
}

Deno.test("selectNearestAtmOptionPair: picks the listed nearest expiry and complete ATM pair", () => {
  const pair = selectNearestAtmOptionPair(
    [
      contract("NIFTY02JUN2625000CE", "2500000"),
      contract("NIFTY02JUN2625000PE", "2500000"),
      contract("NIFTY02JUN2625050CE", "2505000"),
      contract("NIFTY02JUN2625050PE", "2505000"),
      contract("NIFTY09JUN2625000CE", "2500000", "09JUN2026"),
      contract("NIFTY09JUN2625000PE", "2500000", "09JUN2026"),
    ],
    25042,
    new Date("2026-06-01T04:45:00.000Z"),
  );

  assertEquals(pair.expiryDate, "2026-06-02");
  assertEquals(pair.strike, 25050);
  assertEquals(pair.ce.symbol, "NIFTY02JUN2625050CE");
  assertEquals(pair.pe.symbol, "NIFTY02JUN2625050PE");
});

Deno.test("buildPremiumDecayPoint: calculates signed premium movement from the session baseline", () => {
  const pair = selectNearestAtmOptionPair(
    [
      contract("NIFTY02JUN2625000CE", "2500000"),
      contract("NIFTY02JUN2625000PE", "2500000"),
    ],
    25005,
    new Date("2026-06-01T04:45:00.000Z"),
  );

  const point = buildPremiumDecayPoint(
    new Date("2026-06-01T05:15:00.000Z"),
    pair,
    25005,
    142,
    86,
    { ce_ltp: "130", pe_ltp: "90" },
  );

  assertEquals(point.series_key, PREMIUM_DECAY_SERIES_KEY);
  assertEquals(point.ce_decay, 12);
  assertEquals(point.pe_decay, -4);
});

Deno.test("buildPremiumDecayPoint: accepts explicit seriesKey for band rows", () => {
  const pair = selectNearestAtmOptionPair(
    [
      contract("NIFTY02JUN2625000CE", "2500000"),
      contract("NIFTY02JUN2625000PE", "2500000"),
    ],
    25005,
    new Date("2026-06-01T04:45:00.000Z"),
  );

  const point = buildPremiumDecayPoint(
    new Date("2026-06-01T05:15:00.000Z"),
    pair,
    25005,
    142,
    86,
    null,
    PREMIUM_DECAY_BAND_SERIES_KEY,
  );

  assertEquals(point.series_key, PREMIUM_DECAY_BAND_SERIES_KEY);
});

function bandInstruments(): AngelInstrument[] {
  const strikes = [24750, 24800, 24850, 24900, 24950, 25000, 25050, 25100, 25150, 25200, 25250];
  return strikes.flatMap((s) => [
    contract(`NIFTY02JUN26${s * 100}CE`, String(s * 100)),
    contract(`NIFTY02JUN26${s * 100}PE`, String(s * 100)),
  ]);
}

Deno.test("selectAtmBandPairs: returns ATM + 5 ITM on each side (11 total)", () => {
  // underlyingLtp=25010 puts ATM firmly at 25000; band spans 24750–25250, all present
  const pairs = selectAtmBandPairs(bandInstruments(), 25010, new Date("2026-06-01T04:45:00.000Z"));
  assertEquals(pairs.length, 11);
  assertEquals(pairs[0].strike, 24750);
  assertEquals(pairs[5].strike, 25000);
  assertEquals(pairs[10].strike, 25250);
});

Deno.test("selectAtmBandPairs: skips strikes with incomplete CE/PE pair", () => {
  const instruments = bandInstruments().filter((i) => !i.symbol.includes("2475000CE"));
  const pairs = selectAtmBandPairs(instruments, 25010, new Date("2026-06-01T04:45:00.000Z"));
  assertEquals(pairs.length, 10);
  assertEquals(pairs.some((p) => p.strike === 24750), false);
});

Deno.test("selectAtmBandPairs: sideCount param controls band width", () => {
  const pairs = selectAtmBandPairs(bandInstruments(), 25010, new Date("2026-06-01T04:45:00.000Z"), 2);
  assertEquals(pairs.length, 5);
  assertEquals(pairs[0].strike, 24900);
  assertEquals(pairs[4].strike, 25100);
});
