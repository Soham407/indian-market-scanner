'use client';

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/client';

// Reads and writes go to bot_settings — the table the bot's edge functions
// actually gate on. Writes use the bot_set_trading RPC because RLS only
// grants SELECT to authenticated users.
export function BotControls() {
  const [tradingEnabled, setTradingEnabled] = useState(true);
  const [killSwitchReason, setKillSwitchReason] = useState<string | null>(null);
  const [circuitBreakerTriggered, setCircuitBreakerTriggered] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const supabase = createBrowserClient();

  // Load initial state
  useEffect(() => {
    if (!supabase) {
      setError('Supabase is not configured');
      setLoading(false);
      return;
    }

    const loadBotSettings = async () => {
      try {
        const { data, error: queryError } = await supabase
          .from('bot_settings')
          .select('trading_enabled, kill_switch_reason, circuit_breaker_tripped_at')
          .eq('id', 1)
          .single();

        if (queryError) throw queryError;

        if (data) {
          setTradingEnabled(data.trading_enabled);
          setKillSwitchReason(data.kill_switch_reason);
          setCircuitBreakerTriggered(!!data.circuit_breaker_tripped_at);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load bot settings');
      } finally {
        setLoading(false);
      }
    };

    loadBotSettings();

    // Subscribe to real-time updates
    const channel = supabase
      .channel('bot_settings_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'bot_settings',
          filter: 'id=eq.1',
        },
        (payload) => {
          const newData = payload.new as {
            trading_enabled: boolean;
            kill_switch_reason: string | null;
            circuit_breaker_tripped_at: string | null;
          };
          setTradingEnabled(newData.trading_enabled);
          setKillSwitchReason(newData.kill_switch_reason);
          setCircuitBreakerTriggered(!!newData.circuit_breaker_tripped_at);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  const setTrading = async (enabled: boolean) => {
    if (!supabase) return;
    try {
      setLoading(true);

      const { error: rpcError } = await supabase.rpc('bot_set_trading', {
        p_enabled: enabled,
      });

      if (rpcError) throw rpcError;

      setTradingEnabled(enabled);
      if (enabled) {
        setKillSwitchReason(null);
        setCircuitBreakerTriggered(false);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update trading status');
    } finally {
      setLoading(false);
    }
  };

  const toggleTrading = () => setTrading(!tradingEnabled);
  const resetCircuitBreaker = () => setTrading(true);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">Bot Controls</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {tradingEnabled ? '✅ Trading ENABLED' : '🛑 Trading DISABLED'}
          </p>
          {!tradingEnabled && killSwitchReason && (
            <p className="text-xs text-gray-500 dark:text-gray-500">{killSwitchReason}</p>
          )}
        </div>
        <button
          onClick={toggleTrading}
          disabled={loading}
          className={`relative inline-flex h-8 w-16 items-center rounded-full transition-colors ${
            tradingEnabled
              ? 'bg-green-500 hover:bg-green-600'
              : 'bg-red-500 hover:bg-red-600'
          } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span
            className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
              tradingEnabled ? 'translate-x-9' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {circuitBreakerTriggered && (
        <div className="mt-4 rounded-lg bg-red-100 p-4 dark:bg-red-900">
          <p className="text-sm font-semibold text-red-900 dark:text-red-100">
            ⛔ Circuit Breaker Triggered
          </p>
          <p className="text-xs text-red-800 dark:text-red-200">
            Daily loss limit exceeded. Trading paused — auto-resumes next trading day.
          </p>
          <button
            onClick={resetCircuitBreaker}
            disabled={loading}
            className="mt-2 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
          >
            Reset Circuit Breaker
          </button>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg bg-yellow-100 p-3 dark:bg-yellow-900">
          <p className="text-xs text-yellow-900 dark:text-yellow-100">{error}</p>
        </div>
      )}
    </div>
  );
}
