import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getMarketSessionStatus } from "./market-hours.ts";

Deno.test("market session: opens at 9:15 AM IST on a trading weekday", () => {
  assertEquals(
    getMarketSessionStatus(new Date("2026-06-02T03:45:00.000Z")).isOpen,
    true,
  );
});

Deno.test("market session: remains open through 3:30 PM IST on a trading weekday", () => {
  assertEquals(
    getMarketSessionStatus(new Date("2026-06-02T10:00:00.000Z")).isOpen,
    true,
  );
});

Deno.test("market session: closes outside NSE trading hours", () => {
  assertEquals(
    getMarketSessionStatus(new Date("2026-06-02T03:44:59.999Z")).isOpen,
    false,
  );
  assertEquals(
    getMarketSessionStatus(new Date("2026-06-02T10:01:00.000Z")).isOpen,
    false,
  );
});

Deno.test("market session: closes on weekends and configured NSE holidays", () => {
  assertEquals(
    getMarketSessionStatus(new Date("2026-06-06T03:45:00.000Z")).isOpen,
    false,
  );
  assertEquals(
    getMarketSessionStatus(new Date("2026-06-26T03:45:00.000Z")).isOpen,
    false,
  );
});
