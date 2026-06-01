import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPremiumDecayPoint,
  PREMIUM_DECAY_SERIES_KEY,
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
