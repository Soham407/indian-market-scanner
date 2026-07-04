import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOvernightEntry,
  settleOvernight,
  sizeOvernight,
  OVERNIGHT_STOP_PCT,
} from "./overnight.ts";

Deno.test("sizeOvernight: risk-based, floors to whole shares", () => {
  // ₹1000 risk, ~1% gap on a ₹100 stock => 1% of 100 = ₹1 risk/share => 1000 shares
  assertEquals(sizeOvernight(100, 1000), 1000);
  assertEquals(sizeOvernight(2500, 1000), 40); // 1% of 2500 = 25 => 1000/25 = 40
  assertEquals(sizeOvernight(0, 1000), 0); // bad price
  assertEquals(sizeOvernight(100, 0), 0); // no risk budget
});

Deno.test("buildOvernightEntry: valid long with positive wide stop/target", () => {
  const e = buildOvernightEntry(100, 1000)!;
  assertEquals(e.side, "long");
  assertEquals(e.shares, 1000);
  assert(e.stop_loss_price > 0 && e.stop_loss_price < 100, "stop below entry, positive");
  assert(e.target_price > 100, "target above entry");
  // wide sentinels, never hit intraday
  assertEquals(e.stop_loss_price, Number((100 * (1 - OVERNIGHT_STOP_PCT)).toFixed(4)));
});

Deno.test("buildOvernightEntry: rejects when size is zero", () => {
  assertEquals(buildOvernightEntry(0, 1000), null);
});

Deno.test("settleOvernight: delivery charges are ~0.29%, far above intraday", () => {
  // buy 100 shares @100 (val 10000), sell @102 (val 10200) => gross +200
  const s = settleOvernight(100, 102, 100);
  assertEquals(s.gross_pnl, 200);
  assertEquals(s.brokerage, 40); // ₹20 x2
  // Delivery statutory dominated by STT 0.1% both legs (10 + 10.2 = 20.2),
  // plus stamp 1.5, DP 18.5, exch/sebi/gst — must far exceed old 0.05% model.
  assert(s.statutory_charges > 40, `expected heavy delivery charges, got ${s.statutory_charges}`);
  assert(s.statutory_charges < 60, `sanity ceiling, got ${s.statutory_charges}`);
  assertEquals(s.net_pnl, Number((200 - 40 - s.statutory_charges).toFixed(4)));
});

Deno.test("settleOvernight: STT both legs — a 0.15% gross edge nets NEGATIVE", () => {
  // This is the economic fact that killed the strategy: gross +0.15% on ₹1L
  // notional (+150) minus ~₹290 delivery charges => net loss.
  const s = settleOvernight(100, 100.15, 1000); // 1000 sh @100 = ₹1L, +0.15% gap
  assertEquals(s.gross_pnl, Number((150).toFixed(4)));
  assert(s.net_pnl < 0, `0.15% gross must net negative on delivery, got ${s.net_pnl}`);
});

Deno.test("settleOvernight: gap down loses, charges deepen it", () => {
  const s = settleOvernight(100, 99, 100); // gross -100
  assertEquals(s.gross_pnl, -100);
  assert(s.net_pnl < -100, "charges make a losing trade worse");
});

Deno.test("settleOvernight: charges alone make a flat trade negative", () => {
  const s = settleOvernight(100, 100, 100); // gross 0
  assertEquals(s.gross_pnl, 0);
  assert(s.net_pnl < 0, "flat close still pays brokerage + statutory");
});
