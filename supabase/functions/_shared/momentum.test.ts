import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { trailingReturn, rankTopN, rebalanceDelta, sizeShares, settleDelivery } from "./momentum.ts";

Deno.test("trailingReturn: pct over lookback, null if short", () => {
  assert(Math.abs(trailingReturn([100, 110, 120], 2)! - 0.2) < 1e-9); // 120/100 - 1
  assertEquals(trailingReturn([100, 110], 5), null);      // not enough history
  assertEquals(trailingReturn([0, 110, 120], 2), null);   // bad past price
});

Deno.test("rankTopN: strongest first, drops NaN", () => {
  const moms = { A: 0.3, B: 0.9, C: -0.1, D: NaN, E: 0.5 };
  assertEquals(rankTopN(moms, 3), ["B", "E", "A"]);
});

Deno.test("rebalanceDelta: buy new winners, sell dropouts, hold overlap", () => {
  const d = rebalanceDelta(["A", "B", "C"], ["B", "C", "D"]);
  assertEquals(d.buy, ["D"]);
  assertEquals(d.sell, ["A"]);
});

Deno.test("sizeShares: floors to whole shares", () => {
  assertEquals(sizeShares(100, 10000), 100);
  assertEquals(sizeShares(3333, 10000), 3);
  assertEquals(sizeShares(0, 10000), 0);
});

Deno.test("settleDelivery: winner nets positive after delivery charges", () => {
  // buy 100 @100 (10000), sell @115 (11500) => gross +1500, charges ~₹75 => net > 1400
  const s = settleDelivery(100, 115, 100);
  assertEquals(s.gross_pnl, 1500);
  assert(s.net_pnl > 1350 && s.net_pnl < 1450, `net ${s.net_pnl}`);
  assert(s.statutory_charges > 0 && s.brokerage === 40);
});

Deno.test("settleDelivery: small move eaten by charges (why swing needs big moves)", () => {
  // +0.3% on a ₹10k position is ~₹30 gross vs ~₹60 charges => net negative
  const s = settleDelivery(100, 100.3, 100);
  assert(s.net_pnl < 0, `tiny move should net negative, got ${s.net_pnl}`);
});
