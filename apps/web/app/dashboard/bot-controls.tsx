'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase';
import { Bell, AlertTriangle, ToggleLeft, ToggleRight } from 'lucide-react';

export function BotControls() {
  const [tradingEnabled, setTradingEnabled] = useState(true);
  const [circuitBreakerTriggered, setCircuitBreakerTriggered] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const { data, error } = await supabase
          .from('bot_config')
          .select('trading_enabled, circuit_breaker_triggered_at')
          .eq('id', 1)
          .single();

        if (error) throw error;

        setTradingEnabled(data.trading_enabled ?? true);
        setCircuitBreakerTriggered(!!data.circuit_breaker_triggered_at);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load config');
      } finally {
        setLoading(false);
      }
    };

    loadConfig();

    // Subscribe to real-time changes
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
          if (payload.new) {
            setTradingEnabled(payload.new.trading_enabled ?? true);
            setCircuitBreakerTriggered(!!payload.new.circuit_breaker_triggered_at);
          }
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, []);

  const handleToggleTradingEnabled = async () => {
    try {
      setLoading(true);
      const newState = !tradingEnabled;

      const { error } = await supabase
        .from('bot_config')
        .update({ trading_enabled: newState })
        .eq('id', 1);

      if (error) throw error;

      setTradingEnabled(newState);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update trading state');
      // Revert on error
      setTradingEnabled(!tradingEnabled);
    } finally {
      setLoading(false);
    }
  };

  const handleResetCircuitBreaker = async () => {
    try {
      setLoading(true);

      const { error } = await supabase
        .from('bot_config')
        .update({ circuit_breaker_triggered_at: null })
        .eq('id', 1);

      if (error) throw error;

      setCircuitBreakerTriggered(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset circuit breaker');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <div className="h-6 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${tradingEnabled ? 'bg-green-500' : 'bg-red-500'}`} />
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Trading Status</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {tradingEnabled ? 'Bot is trading' : 'Trading disabled (Kill Switch ON)'}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggleTradingEnabled}
          disabled={loading}
          className="rounded-lg bg-gray-100 p-2 transition hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:hover:bg-gray-700"
        >
          {tradingEnabled ? (
            <ToggleRight className="h-6 w-6 text-green-500" />
          ) : (
            <ToggleLeft className="h-6 w-6 text-red-500" />
          )}
        </button>
      </div>

      {circuitBreakerTriggered && (
        <div className="flex items-start gap-3 rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950">
          <AlertTriangle className="h-5 w-5 flex-shrink-0 text-orange-600 dark:text-orange-400" />
          <div className="flex-1">
            <p className="font-semibold text-orange-900 dark:text-orange-100">Circuit Breaker Triggered</p>
            <p className="text-sm text-orange-800 dark:text-orange-200">
              Daily loss exceeded ₹3,000. Trading is paused.
            </p>
            <button
              onClick={handleResetCircuitBreaker}
              disabled={loading}
              className="mt-2 text-sm font-medium text-orange-700 hover:text-orange-900 disabled:opacity-50 dark:text-orange-300 dark:hover:text-orange-100"
            >
              Reset Circuit Breaker
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
          <Bell className="h-4 w-4" />
          {error}
        </div>
      )}
    </div>
  );
}
