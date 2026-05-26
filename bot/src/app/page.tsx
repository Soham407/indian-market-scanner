"use client";

import { useEffect, useMemo, useState } from "react";
import { getHeartbeatStatus } from "@/lib/heartbeat";
import { formatVolume, getCandleAgeLabel } from "@/lib/latest-candle";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";

type BotSettingsRow = {
  last_heartbeat_at: string | null;
};

type LatestCandleRow = {
  close: number;
  volume: number;
  candle_open_at: string;
};

export default function HomePage() {
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [latestCandle, setLatestCandle] = useState<LatestCandleRow | null>(null);
  const [now, setNow] = useState(() => new Date());

  const status = useMemo(() => getHeartbeatStatus(lastHeartbeatAt, now), [lastHeartbeatAt, now]);
  const candleAge = useMemo(
    () => (latestCandle ? getCandleAgeLabel(latestCandle.candle_open_at, now) : "loading"),
    [latestCandle, now],
  );

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const supabase = getBrowserSupabaseClient();

    const loadHeartbeat = async () => {
      const { data } = await supabase
        .from("bot_settings")
        .select("last_heartbeat_at")
        .eq("id", 1)
        .single();

      if (data) {
        setLastHeartbeatAt((data as BotSettingsRow).last_heartbeat_at);
      }
    };

    const loadLatestCandle = async () => {
      const { data } = await supabase
        .from("bot_candles")
        .select("close,volume,candle_open_at,instruments!inner(symbol)")
        .eq("timeframe", "5m")
        .eq("instruments.symbol", "RELIANCE")
        .order("candle_open_at", { ascending: false })
        .limit(1);

      const row = (data?.[0] ?? null) as LatestCandleRow | null;
      setLatestCandle(row);
    };

    void loadHeartbeat();
    void loadLatestCandle();

    const candlePoll = setInterval(() => {
      void loadLatestCandle();
    }, 60_000);

    const channel = supabase
      .channel("bot-settings-heartbeat")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "bot_settings",
          filter: "id=eq.1",
        },
        (payload) => {
          const row = payload.new as BotSettingsRow;
          setLastHeartbeatAt(row.last_heartbeat_at);
          setNow(new Date());
        },
      )
      .subscribe();

    return () => {
      clearInterval(candlePoll);
      void supabase.removeChannel(channel);
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center p-6">
      <div className="grid w-full gap-4">
        <div
          className={`w-full rounded-2xl border p-8 shadow-sm ${status.isAlive ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}
        >
          <p className="text-2xl font-semibold tracking-tight text-gray-900">
            Bot status: <span className={status.isAlive ? "text-emerald-700" : "text-red-700"}>{status.label}</span>{" "}
            (last heartbeat: {status.message})
          </p>
        </div>
        <div className="w-full rounded-2xl border border-sky-200 bg-sky-50 p-8 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-wide text-sky-800">Latest candle</p>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-gray-900">RELIANCE · 5-minute</p>
          <p className="mt-2 text-lg text-gray-800">
            Close:{" "}
            <span className="font-semibold">
              {latestCandle ? `₹${latestCandle.close.toFixed(2)}` : "loading"}
            </span>
          </p>
          <p className="mt-1 text-lg text-gray-800">
            Volume:{" "}
            <span className="font-semibold">{latestCandle ? formatVolume(latestCandle.volume) : "loading"}</span>
          </p>
          <p className="mt-1 text-lg text-gray-800">
            Age: <span className="font-semibold">{candleAge}</span>
          </p>
        </div>
      </div>
    </main>
  );
}
