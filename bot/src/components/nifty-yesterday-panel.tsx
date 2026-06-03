"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import { getNiftyMidValue } from "@/lib/oi-analysis";

type NiftyOhlc = {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
};

function fmt(val: number | null): string {
  if (val === null) return "—";
  return val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function NiftyYesterdayPanel() {
  const [ohlc, setOhlc] = useState<NiftyOhlc>({ open: null, high: null, low: null, close: null });

  useEffect(() => {
    const supabase = getBrowserSupabaseClient();

    const load = async () => {
      const { data } = await supabase
        .from("bot_settings")
        .select("nifty_previous_open, nifty_previous_high, nifty_previous_low, nifty_previous_close")
        .eq("id", 1)
        .single();

      if (data) {
        const row = data as {
          nifty_previous_open: number | null;
          nifty_previous_high: number | null;
          nifty_previous_low: number | null;
          nifty_previous_close: number | null;
        };
        setOhlc({
          open: row.nifty_previous_open,
          high: row.nifty_previous_high,
          low: row.nifty_previous_low,
          close: row.nifty_previous_close,
        });
      }
    };

    void load();

    const channel = supabase
      .channel("nifty-yesterday-settings")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "bot_settings", filter: "id=eq.1" },
        (payload) => {
          const row = payload.new as {
            nifty_previous_open: number | null;
            nifty_previous_high: number | null;
            nifty_previous_low: number | null;
            nifty_previous_close: number | null;
          };
          setOhlc({
            open: row.nifty_previous_open,
            high: row.nifty_previous_high,
            low: row.nifty_previous_low,
            close: row.nifty_previous_close,
          });
        },
      )
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, []);

  const mid =
    ohlc.high !== null && ohlc.low !== null
      ? getNiftyMidValue(ohlc.high, ohlc.low)
      : null;

  const levels: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: "Prev Open", value: fmt(ohlc.open) },
    { label: "Prev High", value: fmt(ohlc.high) },
    { label: "Prev Low",  value: fmt(ohlc.low) },
    { label: "Prev Close", value: fmt(ohlc.close) },
    { label: "Mid (H+L)/2", value: fmt(mid), highlight: true },
  ];

  return (
    <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/60 bg-white/70 px-6 py-4 shadow-sm backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 shrink-0">
        Nifty yesterday
      </p>
      <div className="flex flex-wrap gap-4">
        {levels.map(({ label, value, highlight }) => (
          <div key={label} className="flex flex-col items-center">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">{label}</span>
            <span
              className={`mt-0.5 text-sm font-semibold tabular-nums ${
                highlight ? "text-indigo-700" : "text-slate-900"
              }`}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
