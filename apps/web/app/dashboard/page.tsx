import { BotControls } from './bot-controls';

export default function DashboardPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Paper Trading Bot</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Automated ORB strategy with risk management and real-time monitoring
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Bot Controls - Kill Switch & Circuit Breaker */}
        <div className="md:col-span-2 lg:col-span-1">
          <BotControls />
        </div>

        {/* Placeholder cards for future stats */}
        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="font-semibold text-gray-900 dark:text-white">Today's P&L</h3>
          <p className="mt-2 text-2xl font-bold text-green-600">Coming Soon</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">Real-time daily profit/loss</p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="font-semibold text-gray-900 dark:text-white">Open Trades</h3>
          <p className="mt-2 text-2xl font-bold text-blue-600">Coming Soon</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">Active positions</p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="font-semibold text-gray-900 dark:text-white">Win Rate</h3>
          <p className="mt-2 text-2xl font-bold text-indigo-600">Coming Soon</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">Winning trades %</p>
        </div>
      </div>

      {/* Activity Log - Coming Soon */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <h3 className="font-semibold text-gray-900 dark:text-white">Recent Activity</h3>
        <div className="mt-4 space-y-3 text-center text-gray-600 dark:text-gray-400">
          <p>Trade execution log, exits, and circuit breaker events</p>
          <p className="text-sm">Coming soon - real-time feed from Telegram & database</p>
        </div>
      </div>

      {/* Documentation Links */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-6 dark:border-blue-900 dark:bg-blue-950">
        <h3 className="font-semibold text-blue-900 dark:text-blue-100">Documentation</h3>
        <ul className="mt-3 space-y-2 text-sm text-blue-800 dark:text-blue-200">
          <li>
            📖{' '}
            <a href="/docs/bot" className="underline hover:no-underline">
              Bot Features Guide
            </a>
          </li>
          <li>
            🚀{' '}
            <a href="/docs/deployment" className="underline hover:no-underline">
              Deployment Guide
            </a>
          </li>
          <li>
            📊{' '}
            <a href="/docs/monitoring" className="underline hover:no-underline">
              Monitoring & Alerts
            </a>
          </li>
          <li>
            ⚙️{' '}
            <a href="/docs/config" className="underline hover:no-underline">
              Configuration Reference
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
