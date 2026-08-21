import { createServiceClient } from "../_shared/supabase.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import { isMarketHoliday, getMarketSessionStatus } from "../_shared/market-hours.ts";

const ANGEL_BASE = "https://apiconnect.angelone.in";

async function checkAngelAuth(): Promise<{ ok: boolean; message: string }> {
  const apiKey = Deno.env.get("AngelOne_Apikey");
  const secretKey = Deno.env.get("AngelOne_SecretKey");
  const clientId = Deno.env.get("AngelOne_ClientID");
  const pin = Deno.env.get("AngelOne_PIN");

  if (!apiKey || !secretKey || !clientId || !pin) {
    return {
      ok: false,
      message: "Missing Angel One secrets (Apikey, SecretKey, ClientID, or PIN)",
    };
  }

  try {
    // Generate TOTP
    const stripped = secretKey.replace(/[-\s]/g, "");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = stripped.toUpperCase().replace(/=/g, "");
    let bits = "";
    for (const ch of cleaned) {
      const value = alphabet.indexOf(ch);
      if (value === -1) {
        return { ok: false, message: "Invalid Angel One TOTP SecretKey format" };
      }
      bits += value.toString(2).padStart(5, "0");
    }
    const keyBytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < keyBytes.length; i++) {
      keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }

    const counter = Math.floor(Date.now() / 1000 / 30);
    const message = new Uint8Array(8);
    let value = counter;
    for (let i = 7; i >= 0; i--) {
      message[i] = value & 0xff;
      value = Math.floor(value / 256);
    }

    const keyData = new Uint8Array(keyBytes.length);
    keyData.set(keyBytes);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData.buffer,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
    const offset = mac[19] & 0x0f;
    const code = ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff);
    const totp = (code % 1_000_000).toString().padStart(6, "0");

    const resp = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "1.1.1.1",
        "X-MACAddress": "00-00-00-00-00-00",
        "X-PrivateKey": apiKey,
      },
      body: JSON.stringify({ clientcode: clientId, password: pin, totp }),
      signal: AbortSignal.timeout(10000),
    });

    const res = await resp.json();
    if (res?.status && res?.data?.jwtToken) {
      return { ok: true, message: "Connected & authenticated (JWT Active)" };
    }
    return {
      ok: false,
      message: `Authentication failed: ${res?.message || "Invalid response from Angel One"}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Network/Auth Exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const forceRun = url.searchParams.get("force") === "true";

  const now = new Date();
  const session = getMarketSessionStatus(now);
  const todayIst = session.istDate;

  // Check if today is weekend or market holiday
  if (!forceRun) {
    if (session.isWeekend || isMarketHoliday(todayIst)) {
      return Response.json({
        status: "Market holiday / weekend",
        message: "9:00 AM check skipped for non-trading day",
        date: todayIst,
      });
    }
  }

  const supabase = createServiceClient();
  const checks: {
    name: string;
    status: "ok" | "error" | "warning";
    details: string;
  }[] = [];

  // 1. Check Bot Settings & Kill Switch
  const { data: settings, error: settingsErr } = await supabase
    .from("bot_settings")
    .select("trading_enabled, kill_switch_reason, circuit_breaker_tripped_at")
    .eq("id", 1)
    .maybeSingle();

  if (settingsErr || !settings) {
    checks.push({
      name: "Database (bot_settings)",
      status: "error",
      details: settingsErr ? settingsErr.message : "bot_settings row 1 missing",
    });
  } else if (!settings.trading_enabled) {
    checks.push({
      name: "Trading Gate",
      status: "warning",
      details: `Trading DISABLED (Reason: ${settings.kill_switch_reason ?? "Manual pause"})`,
    });
  } else {
    checks.push({
      name: "Trading Gate",
      status: "ok",
      details: "Trading ENABLED & active",
    });
  }

  // 2. Check Active Instruments (Pre-market sync check)
  const { count: activeCount, error: activeErr } = await supabase
    .from("bot_active_instruments")
    .select("id", { count: "exact", head: true })
    .gte("expiry_date", todayIst);

  if (activeErr) {
    checks.push({
      name: "Options Active Instruments",
      status: "error",
      details: activeErr.message,
    });
  } else if (!activeCount || activeCount === 0) {
    checks.push({
      name: "Options Active Instruments",
      status: "warning",
      details: "0 active contracts found (sync might run at 08:30 or using fallback)",
    });
  } else {
    checks.push({
      name: "Options Active Instruments",
      status: "ok",
      details: `${activeCount} active NIFTY contracts ready for today`,
    });
  }

  // 3. Check NSE Equities Instruments Master
  const { count: instCount, error: instErr } = await supabase
    .from("instruments")
    .select("id", { count: "exact", head: true })
    .eq("exchange", "NSE");

  if (instErr) {
    checks.push({
      name: "NSE Equities Table",
      status: "error",
      details: instErr.message,
    });
  } else {
    checks.push({
      name: "NSE Equities Table",
      status: "ok",
      details: `${instCount ?? 0} symbols available`,
    });
  }

  // 4. Check Angel One SmartAPI Authentication
  const angelStatus = await checkAngelAuth();
  checks.push({
    name: "Angel One SmartAPI",
    status: angelStatus.ok ? "ok" : "error",
    details: angelStatus.message,
  });

  // Calculate Overall Status
  const hasError = checks.some((c) => c.status === "error");
  const hasWarning = checks.some((c) => c.status === "warning");

  const overallIcon = hasError ? "🚨" : hasWarning ? "⚠️" : "🟢";
  const overallTitle = hasError
    ? "FAILED - ACTION REQUIRED"
    : hasWarning
    ? "WARNING - VERIFY SETTINGS"
    : "ALL SYSTEMS GO";

  const lines = [
    `${overallIcon} <b>[Options Dashboard] 9:00 AM Pre-Market Check</b>`,
    `<b>Status:</b> ${overallTitle}`,
    `<b>Date:</b> ${todayIst} (Market opens 9:15 AM IST)`,
    "",
    "<b>System Component Checks:</b>",
    ...checks.map((c) => {
      const icon = c.status === "ok" ? "✅" : c.status === "warning" ? "⚠️" : "❌";
      return `${icon} <b>${c.name}</b>: ${c.details}`;
    }),
    "",
    hasError
      ? "<i>⚠️ Please inspect issues before market open at 09:15 AM IST.</i>"
      : "<i>🚀 Everything is green. The engine will begin scanning at 09:15 AM IST.</i>",
  ];

  const notificationMessage = lines.join("\n");

  // Always send Telegram message on 9:00 AM check (success AND failure)
  const tgResult = await sendTelegramNotification({
    type: "preflight",
    symbol: "PREFLIGHT",
    timestamp: now.toISOString(),
    message: notificationMessage,
  });

  return Response.json({
    ok: !hasError,
    status: overallTitle,
    checks,
    telegram_sent: tgResult.success,
    telegram_error: tgResult.error,
  });
});
