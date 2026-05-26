import { BotControls } from '@/components/bot-controls';

export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            🤖 Paper Trading Bot
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Opening Range Breakout Strategy - NSE Equities
          </p>
        </div>

        <div className="grid gap-6">
          <BotControls />

          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              📊 Strategy Overview
            </h3>
            <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <p>
                <strong>Opening Range:</strong> 9:15 AM - 9:30 AM IST (15 minutes)
              </p>
              <p>
                <strong>Breakout Window:</strong> 9:30 AM - 3:30 PM IST
              </p>
              <p>
                <strong>Risk per Trade:</strong> ₹1,000
              </p>
              <p>
                <strong>Circuit Breaker:</strong> -₹3,000 daily loss
              </p>
              <p>
                <strong>Execution:</strong> Paper trading with realistic slippage & fees
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              🔗 Links
            </h3>
            <div className="space-y-2">
              <p className="text-sm">
                <strong>Telegram:</strong>{' '}
                <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                  @TMTMarketscanner_bot
                </code>
              </p>
              <p className="text-sm">
                <strong>Deployment:</strong> Live (Go Live: 2026-05-27, 9:15 AM IST)
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
