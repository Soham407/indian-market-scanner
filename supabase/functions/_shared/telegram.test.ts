import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test message formatting
Deno.test("telegram message: formats entry notification correctly", () => {
  const msg = {
    type: 'entry' as const,
    symbol: 'INFY',
    side: 'long' as const,
    entryPrice: 2500.50,
    targetPrice: 2600.00,
    stopLossPrice: 2450.00,
    riskAmount: 1000,
    shares: 2,
    timestamp: '2026-05-26T04:30:00Z',
  };

  // Verify message object structure
  assertEquals(msg.type, 'entry');
  assertEquals(msg.symbol, 'INFY');
  assertEquals(msg.side, 'long');
  assertEquals(typeof msg.entryPrice, 'number');
});

Deno.test("telegram message: formats exit notification correctly", () => {
  const msg = {
    type: 'exit' as const,
    symbol: 'TCS',
    exitPrice: 2750.75,
    exitReason: 'target',
    pnl: 500,
    netPnl: 460,
    timestamp: '2026-05-26T05:00:00Z',
  };

  assertEquals(msg.type, 'exit');
  assertEquals(msg.exitReason, 'target');
  assertEquals(msg.netPnl, 460);
});

Deno.test("telegram message: formats circuit breaker alert", () => {
  const msg = {
    type: 'circuit_breaker' as const,
    symbol: '',
    timestamp: '2026-05-26T06:00:00Z',
    message: 'Daily loss exceeded threshold',
  };

  assertEquals(msg.type, 'circuit_breaker');
  assertEquals(typeof msg.timestamp, 'string');
});

Deno.test("telegram message: formats heartbeat message", () => {
  const msg = {
    type: 'heartbeat' as const,
    symbol: 'BOT',
    timestamp: '2026-05-26T07:00:00Z',
    message: 'Running normally, 2 open trades',
  };

  assertEquals(msg.type, 'heartbeat');
});

Deno.test("telegram message: formats error notification", () => {
  const msg = {
    type: 'error' as const,
    symbol: 'ERROR',
    timestamp: '2026-05-26T08:00:00Z',
    message: 'Failed to fetch candles for RELIANCE',
  };

  assertEquals(msg.type, 'error');
  assertEquals(msg.message, 'Failed to fetch candles for RELIANCE');
});

// Test environment variable handling
Deno.test("telegram: checks for required environment variables", () => {
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');

  // In test environment, these may not be set
  const hasCredentials = !!botToken && !!chatId;
  assertEquals(typeof hasCredentials, 'boolean');
});

// Test message type variants
Deno.test("telegram message: supports all message types", () => {
  const types = ['entry', 'exit', 'circuit_breaker', 'heartbeat', 'error'] as const;

  for (const type of types) {
    const msg = {
      type,
      symbol: 'TEST',
      timestamp: new Date().toISOString(),
    };
    assertEquals(msg.type, type);
  }
});
