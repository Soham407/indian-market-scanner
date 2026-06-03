"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import { classifyPcr, computePcr, sumOi, type OiStrikeRow, type PcrClassification } from "@/lib/oi-analysis";

type PcrFloatingButtonProps = {
  rows?: OiStrikeRow[];
};

const ARROW: Record<PcrClassification, string> = {
  bullish: "↑",
  bearish: "↓",
  neutral: "→",
};

const COLORS: Record<PcrClassification, string> = {
  bullish: "border-emerald-300 bg-emerald-50 text-emerald-800 shadow-emerald-100",
  bearish: "border-rose-300 bg-rose-50 text-rose-800 shadow-rose-100",
  neutral: "border-slate-300 bg-slate-50 text-slate-800 shadow-slate-100",
};

export function PcrFloatingButton({ rows: externalRows }: PcrFloatingButtonProps) {
  const [rows, setRows] = useState<OiStrikeRow[]>(externalRows ?? []);

  useEffect(() => {
    if (externalRows) {
      setRows(externalRows);
      return;
    }

    const supabase = getBrowserSupabaseClient();

    const load = async () => {
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
        .select("strike, ce_oi, pe_oi")
        .eq("sampled_at", sampled_at);

      if (data) {
        setRows((data as OiStrikeRow[]).map((r) => ({ strike: r.strike, ce_oi: r.ce_oi, pe_oi: r.pe_oi })));
      }
    };

    void load();
    const interval = setInterval(() => void load(), 60_000);
    return () => clearInterval(interval);
  }, [externalRows]);

  const totalCe = sumOi(rows, "ce");
  const totalPe = sumOi(rows, "pe");
  const pcr = computePcr(totalPe, totalCe);
  const pcrClass = pcr !== null ? classifyPcr(pcr) : null;

  if (pcr === null) {
    return (
      <div
        className="fixed bottom-6 right-6 z-50 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-lg backdrop-blur"
        title="PCR — awaiting OI data"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-slate-400">PCR</p>
        <p className="mt-0.5 text-lg font-bold text-slate-400">—</p>
      </div>
    );
  }

  const cls = pcrClass!;

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur ${COLORS[cls]}`}
      title={`Put-Call Ratio: ${pcr.toFixed(2)} — ${cls}`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] opacity-70">PCR</p>
      <p className="mt-0.5 text-xl font-bold tabular-nums">
        {pcr.toFixed(2)}{" "}
        <span className="text-base">{ARROW[cls]}</span>
      </p>
      <p className="text-[10px] font-medium capitalize opacity-70">{cls}</p>
    </div>
  );
}
