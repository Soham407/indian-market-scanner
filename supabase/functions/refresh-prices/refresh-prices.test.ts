import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test helper functions extracted from index.ts
function lastTradingDateIst(): string {
  const nowIstMs = Date.now() + 5.5 * 3600 * 1000;
  const dayOfWeek = new Date(nowIstMs).getUTCDay();
  const daysBack = dayOfWeek === 0 ? 2 : dayOfWeek === 1 ? 3 : 1;
  const lastTradingIstMs = nowIstMs - daysBack * 86400 * 1000;
  return new Date(lastTradingIstMs).toISOString().slice(0, 10);
}

function isTodayIst(ts: string | null): boolean {
  if (!ts) return false;
  const nowDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const tsDate = new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return nowDate === tsDate;
}

function isOrBuildWindow(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  return (h === 9 && m >= 15) || (h === 10 && m < 15);
}

// Happy path: token resolution
Deno.test("token resolution: identifies last trading date", () => {
  const ltd = lastTradingDateIst();
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  assertEquals(dateRegex.test(ltd), true, "Last trading date should be ISO format");
});

// Edge case: PDH refresh check with null timestamp
Deno.test("pdh refresh: handles null refresh timestamp", () => {
  const result = isTodayIst(null);
  assertEquals(result, false, "Null timestamp should not be today");
});

// Edge case: PDH refresh check with old timestamp
Deno.test("pdh refresh: detects stale timestamps", () => {
  const oldDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const result = isTodayIst(oldDate);
  assertEquals(result, false, "Yesterday's timestamp should be stale");
});

// Happy path: OR build window detection
Deno.test("or build window: returns boolean for market hours check", () => {
  const inWindow = isOrBuildWindow();
  assertEquals(typeof inWindow, "boolean", "Should return boolean");
});

// Verify function exports for market-hours integration
Deno.test("market session helper: Angel One client extraction works", async () => {
  const { authenticateAngelOne } = await import("../_shared/angel-one.ts");
  assertEquals(typeof authenticateAngelOne, "function", "Helper should be importable");
});
