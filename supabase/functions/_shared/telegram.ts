export interface TelegramMessage {
  type: 'entry' | 'exit' | 'circuit_breaker' | 'heartbeat' | 'error' | 'eod_summary';
  symbol: string;
  side?: 'long' | 'short';
  entryPrice?: number;
  exitPrice?: number;
  shares?: number;
  riskAmount?: number;
  targetPrice?: number;
  stopLossPrice?: number;
  exitReason?: string;
  pnl?: number;
  netPnl?: number;
  timestamp: string;
  message?: string;
}

export async function sendTelegramNotification(
  msg: TelegramMessage,
): Promise<{ success: boolean; error?: string }> {
  // Secrets stored in Supabase vault with lowercase names
  const botToken = Deno.env.get('telegram_bot_token') ?? Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('telegram_chat_id') ?? Deno.env.get('TELEGRAM_CHAT_ID');

  if (!botToken || !chatId) {
    return { success: false, error: 'Telegram credentials not configured' };
  }

  let text = '';

  switch (msg.type) {
    case 'entry': {
      const direction = msg.side === 'long' ? '📈 LONG' : '📉 SHORT';
      text = `
${direction} Entry - ${msg.symbol}
Entry: ₹${msg.entryPrice?.toFixed(2)}
Target: ₹${msg.targetPrice?.toFixed(2)}
Stop: ₹${msg.stopLossPrice?.toFixed(2)}
Risk: ₹${msg.riskAmount}
Shares: ${msg.shares}
Time: ${new Date(msg.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      `.trim();
      break;
    }

    case 'exit': {
      const profitEmoji = (msg.netPnl ?? 0) >= 0 ? '✅' : '❌';
      text = `
${profitEmoji} Exit - ${msg.symbol}
Reason: ${msg.exitReason?.toUpperCase()}
Exit: ₹${msg.exitPrice?.toFixed(2)}
Gross P&L: ₹${msg.pnl?.toFixed(2)}
Net P&L: ₹${msg.netPnl?.toFixed(2)}
Time: ${new Date(msg.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      `.trim();
      break;
    }

    case 'circuit_breaker': {
      text = `
⛔ CIRCUIT BREAKER TRIGGERED
Daily loss exceeded ₹3,000
Trading is PAUSED for the day
Time: ${new Date(msg.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      `.trim();
      break;
    }

    case 'heartbeat': {
      text = `
💓 Bot Heartbeat
Status: ${msg.message}
Time: ${new Date(msg.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      `.trim();
      break;
    }

    case 'error': {
      text = `
🚨 ERROR
${msg.message}
Time: ${new Date(msg.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      `.trim();
      break;
    }

    case 'eod_summary': {
      // Pre-formatted message passed directly through msg.message
      text = msg.message ?? '📊 EOD Summary (no data)';
      break;
    }
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
