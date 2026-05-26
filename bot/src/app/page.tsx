"use client";

import { useEffect, useMemo, useState } from "react";
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
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center p-6">
      <div
        className={`w-full rounded-2xl border p-8 shadow-sm ${status.isAlive ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}
      >
        <p className="text-2xl font-semibold tracking-tight text-gray-900">
          Bot status: <span className={status.isAlive ? "text-emerald-700" : "text-red-700"}>{status.label}</span>{" "}
          (last heartbeat: {status.message})
        </p>
      </div>
    </main>
  );
}
