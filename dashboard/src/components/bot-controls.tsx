'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

export function BotControls() {
  const [tradingEnabled, setTradingEnabled] = useState(true);
  const [circuitBreakerTriggered, setCircuitBreakerTriggered] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  );

  // Load initial state
  useEffect(() => {
    const loadBotConfig = async () => {
      try {
        const { data, error: queryError } = await supabase
          .from('bot_config')
          .select('trading_enabled, circuit_breaker_triggered_at')
          .eq('id', 1)
          .single();

        if (queryError) throw queryError;

        if (data) {
          setTradingEnabled(data.trading_enabled);
          setCircuitBreakerTriggered(!!data.circuit_breaker_triggered_at);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load bot config');
      } finally {
        setLoading(false);
      }
    };

    loadBotConfig();

    // Subscribe to real-time updates
    const channel = supabase
      .channel('bot_config_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'bot_config',
          filter: 'id=eq.1',
        },
        (payload) => {
          const newData = payload.new as any;
          setTradingEnabled(newData.trading_enabled);
          setCircuitBreakerTriggered(!!newData.circuit_breaker_triggered_at);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  const toggleTrading = async () => {
    try {
      setLoading(true);
      const newState = !tradingEnabled;

      const { error: updateError } = await supabase
        .from('bot_config')
        .update({
          trading_enabled: newState,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1);

      if (updateError) throw updateError;

      setTradingEnabled(newState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update trading status');
    } finally {
      setLoading(false);
    }
  };

  const resetCircuitBreaker = async () => {
    try {
      setLoading(true);

      const { error: updateError } = await supabase
        .from('bot_config')
        .update({
          circuit_breaker_triggered_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1);

      if (updateError) throw updateError;

      setCircuitBreakerTriggered(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset circuit breaker');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">Bot Controls</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {tradingEnabled ? '✅ Trading ENABLED' : '🛑 Trading DISABLED'}
          </p>
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
            Daily loss limit exceeded. Trading paused until reset.
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
