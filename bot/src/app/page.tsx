"use client";

import { useEffect, useMemo, useState } from "react";
import { PremiumDecayChart } from "@/components/premium-decay-chart";
import { getHeartbeatStatus } from "@/lib/heartbeat";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";

type BotSettingsRow = {
  last_heartbeat_at: string | null;
};

export default function HomePage() {
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const status = useMemo(() => getHeartbeatStatus(lastHeartbeatAt, now), [lastHeartbeatAt, now]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const supabase = getBrowserSupabaseClient();

    const load = async () => {
      const { data } = await supabase
        .from("bot_settings")
        .select("last_heartbeat_at")
        .eq("id", 1)
        .single();

      if (data) {
        setLastHeartbeatAt((data as BotSettingsRow).last_heartbeat_at);
      }
    };

    void load();

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
      void supabase.removeChannel(channel);
    };
  }, []);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.12),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] text-slate-900">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 rounded-[1.5rem] border border-white/60 bg-white/70 px-6 py-5 shadow-[0_20px_60px_-35px_rgba(15,23,42,0.5)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Indian Market Scanner</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Premium decay control room</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Live CE/PE decay streamed from Supabase and rendered as a mirrored intraday area chart for options monitoring.
            </p>
          </div>
          <div
            className={`rounded-2xl border px-4 py-3 shadow-sm ${status.isAlive ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Bot heartbeat</p>
            <p className="mt-1 text-lg font-semibold text-slate-950">
              <span className={status.isAlive ? "text-emerald-700" : "text-rose-700"}>{status.label}</span>
            </p>
            <p className="text-sm text-slate-600">Last update: {status.message}</p>
          </div>
        </header>

        <PremiumDecayChart
          seriesKey="NIFTY-ATM-WEEKLY"
          title="NIFTY premium decay"
          subtitle="Signed CE and PE premium movement from the session baseline, streamed live from Supabase."
        />
      </div>
    </main>
  );
}
