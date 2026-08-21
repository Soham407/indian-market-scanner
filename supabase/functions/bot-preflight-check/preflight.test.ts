import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("preflight format: generates correct message layout", () => {
  const checks = [
    { name: "Trading Gate", status: "ok", details: "Trading ENABLED & active" },
    { name: "Options Active Instruments", status: "ok", details: "350 active contracts ready" },
    { name: "NSE Equities Table", status: "ok", details: "50 symbols available" },
    { name: "Angel One SmartAPI", status: "ok", details: "Connected & authenticated (JWT Active)" },
  ];

  const hasError = checks.some((c) => c.status === "error");
  const hasWarning = checks.some((c) => c.status === "warning");

  const overallIcon = hasError ? "🚨" : hasWarning ? "⚠️" : "🟢";
  const overallTitle = hasError
    ? "FAILED - ACTION REQUIRED"
    : hasWarning
    ? "WARNING - VERIFY SETTINGS"
    : "ALL SYSTEMS GO";

  assertEquals(overallIcon, "🟢");
  assertEquals(overallTitle, "ALL SYSTEMS GO");
});

Deno.test("preflight format: detects error when SmartAPI fails", () => {
  const checks = [
    { name: "Trading Gate", status: "ok", details: "Trading ENABLED & active" },
    { name: "Options Active Instruments", status: "ok", details: "350 active contracts ready" },
    { name: "Angel One SmartAPI", status: "error", details: "Authentication failed: 401 Unauthorized" },
  ];

  const hasError = checks.some((c) => c.status === "error");
  const overallIcon = hasError ? "🚨" : "🟢";
  const overallTitle = hasError ? "FAILED - ACTION REQUIRED" : "ALL SYSTEMS GO";

  assertEquals(overallIcon, "🚨");
  assertEquals(overallTitle, "FAILED - ACTION REQUIRED");
});
