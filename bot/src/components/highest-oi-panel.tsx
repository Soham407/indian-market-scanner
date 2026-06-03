"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import { getHighestOiStrike, type OiStrikeRow } from "@/lib/oi-analysis";

type OiChainRow = {
  strike: number;
  ce_oi: number;
  pe_oi: number;
  sampled_at: string;
};

type HighestOiPanelProps = {
  rows?: OiStrikeRow[];
};

export function HighestOiPanel({ rows: externalRows }: HighestOiPanelProps) {
  const [rows, setRows] = useState<OiStrikeRow[]>(externalRows ?? []);

  useEffect(() => {
    if (externalRows) {
      setRows(externalRows);
      return;
    }

    const supabase = getBrowserSupabaseClient();

    const load = async () => {
      // Get the latest sampled_at for today's session
      const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      const { data: latestRow } = await supabase
        .from("bot_nifty_oi_chain")
        .select("sampled_at")
        .eq("session_date", today)
        .order("sampled_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!latestRow) return;
      const { sampled_at } = latestRow as { sampled_at: string };

      const { data } = await supabase
        .from("bot_nifty_oi_chain")
        .select("strike, ce_oi, pe_oi, sampled_at")
        .eq("sampled_at", sampled_at)
        .order("strike", { ascending: true });

      if (data) setRows((data as OiChainRow[]).map((r) => ({ strike: r.strike, ce_oi: r.ce_oi, pe_oi: r.pe_oi })));
    };

    void load();

    const interval = setInterval(() => void load(), 60_000);
    return () => clearInterval(interval);
  }, [externalRows]);

  const ceMax = getHighestOiStrike(rows, "ce");
  const peMax = getHighestOiStrike(rows, "pe");

  return (
    <section className="flex flex-wrap items-center gap-6 rounded-2xl border border-white/60 bg-white/70 px-6 py-4 shadow-sm backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 shrink-0">
        Highest open interest
      </p>
      <div className="flex flex-wrap gap-6">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">CE</span>
          <span className="text-base font-bold tabular-nums text-slate-900">
            {ceMax
              ? ceMax.strike.toLocaleString("en-IN", { maximumFractionDigits: 0 })
              : "—"}
          </span>
          {ceMax ? (
            <span className="text-xs text-slate-500">
              OI {(ceMax.oi / 1_00_000).toFixed(1)}L
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-800">PE</span>
          <span className="text-base font-bold tabular-nums text-slate-900">
            {peMax
              ? peMax.strike.toLocaleString("en-IN", { maximumFractionDigits: 0 })
              : "—"}
          </span>
          {peMax ? (
            <span className="text-xs text-slate-500">
              OI {(peMax.oi / 1_00_000).toFixed(1)}L
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
