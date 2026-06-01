"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import {
  buildBandAveragedSeries,
  buildPremiumDecayAreaPath,
  buildDemoPremiumDecayRows,
  buildLinearPremiumDecayPath,
  buildReadableTimeTickIndices,
  formatPremiumDecayTime,
  type PremiumDecayMinutePoint,
  type PremiumDecayRow,
} from "@/lib/premium-decay";
import {
  NSE_BAND_ROW_LIMIT,
  getPremiumDecayPlotClipRect,
  getPremiumDecaySvgWidth,
} from "@/lib/options-chart-ui";

const BAND_SERIES_KEY = "NIFTY-BAND-WEEKLY";
const BASE_SVG_WIDTH = 1000;
const SVG_HEIGHT = 420;
const MARGIN = { top: 28, right: 28, bottom: 56, left: 68 };

type ChartMetrics = {
  minY: number;
  maxY: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

function buildMetrics(slots: PremiumDecayMinutePoint[], svgWidth: number): ChartMetrics {
  const values = slots.flatMap((s) => [s.ceDecay, s.chartPeDecay, 0]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(5, (rawMax - rawMin) * 0.15);
  return {
    minY: rawMin - padding,
    maxY: rawMax + padding,
    left: MARGIN.left,
    top: MARGIN.top,
    width: svgWidth - MARGIN.left - MARGIN.right,
    height: SVG_HEIGHT - MARGIN.top - MARGIN.bottom,
  };
}

function sx(index: number, total: number, m: ChartMetrics): number {
  if (total <= 1) return m.left + m.width / 2;
  return m.left + (index / (total - 1)) * m.width;
}

function sy(value: number, m: ChartMetrics): number {
  const range = m.maxY - m.minY;
  if (range === 0) return m.top + m.height / 2;
  return m.top + m.height - ((value - m.minY) / range) * m.height;
}

function linePath(slots: PremiumDecayMinutePoint[], m: ChartMetrics, key: "ceDecay" | "chartPeDecay"): string {
  return buildLinearPremiumDecayPath(
    slots,
    key,
    (i) => sx(i, slots.length, m),
    (v) => sy(v, m),
  );
}

function areaPath(slots: PremiumDecayMinutePoint[], m: ChartMetrics, key: "ceDecay" | "chartPeDecay"): string {
  return buildPremiumDecayAreaPath(
    slots,
    key,
    (index) => sx(index, slots.length, m),
    (value) => sy(value, m),
  );
}

function demoBandSlots(): PremiumDecayMinutePoint[] {
  const allRows: PremiumDecayRow[] = [];
  for (let offset = -250; offset <= 250; offset += 50) {
    const demoRows = buildDemoPremiumDecayRows(`demo-band-${offset}`).map((r) => ({
      ...r,
      series_key: BAND_SERIES_KEY,
      strike: 25000 + offset,
      ce_decay: Number(r.ce_decay) * (1 + offset * 0.001),
      pe_decay: Number(r.pe_decay) * (1 + offset * 0.001),
    }));
    allRows.push(...demoRows);
  }
  return buildBandAveragedSeries(allRows);
}

export function BandAverageChart() {
  const [rows, setRows] = useState<PremiumDecayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isActive = true;
    const supabase = getBrowserSupabaseClient();

    const loadRows = async () => {
      setLoading(true);
      setError(null);
      const { data, error: qErr } = await supabase
        .from("bot_premium_decay_points")
        .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
        .eq("series_key", BAND_SERIES_KEY)
        .order("sampled_at", { ascending: false })
        .limit(NSE_BAND_ROW_LIMIT);

      if (!isActive) return;
      if (qErr) { setError(qErr.message); setRows([]); }
      else setRows((data ?? []) as PremiumDecayRow[]);
      setLoading(false);
    };

    void loadRows();
    const interval = setInterval(() => void loadRows(), 30_000);

    const channel = supabase
      .channel("band-average-decay")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "bot_premium_decay_points", filter: `series_key=eq.${BAND_SERIES_KEY}` },
        (payload) => {
          const next = payload.new as PremiumDecayRow;
          setRows((cur) => {
            const merged = [...cur.filter((r) => r.id !== next.id), next];
            merged.sort((a, b) => new Date(a.sampled_at).getTime() - new Date(b.sampled_at).getTime());
            return merged.slice(-NSE_BAND_ROW_LIMIT);
          });
          setError(null);
        })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "bot_premium_decay_points" },
        () => void loadRows())
      .subscribe();

    return () => {
      isActive = false;
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, []);

  const slots = useMemo(() => {
    const band = buildBandAveragedSeries(rows);
    return band.length > 0 ? band : demoBandSlots();
  }, [rows]);

  const isDemo = rows.length === 0;
  const latest = slots.at(-1);
  const svgWidth = getPremiumDecaySvgWidth(slots.length);
  const metrics = useMemo(() => buildMetrics(slots, svgWidth), [slots, svgWidth]);
  const zeroY = sy(0, metrics);
  const plotClipRect = getPremiumDecayPlotClipRect(svgWidth);
  const ceArea = useMemo(() => areaPath(slots, metrics, "ceDecay"), [slots, metrics]);
  const peArea = useMemo(() => areaPath(slots, metrics, "chartPeDecay"), [slots, metrics]);
  const ceLine = useMemo(() => linePath(slots, metrics, "ceDecay"), [slots, metrics]);
  const peLine = useMemo(() => linePath(slots, metrics, "chartPeDecay"), [slots, metrics]);

  const timeTickIndices = useMemo(
    () => new Set(buildReadableTimeTickIndices(slots.length, svgWidth - MARGIN.left - MARGIN.right)),
    [slots.length, svgWidth],
  );

  const yTicks = useMemo(() => {
    const count = 5;
    return Array.from({ length: count }, (_, i) => metrics.maxY - (i / (count - 1)) * (metrics.maxY - metrics.minY));
  }, [metrics.maxY, metrics.minY]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, [svgWidth]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (slots.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * svgWidth;
      const raw = ((svgX - MARGIN.left) / (svgWidth - MARGIN.left - MARGIN.right)) * (slots.length - 1);
      setHoverIndex(Math.max(0, Math.min(slots.length - 1, Math.round(raw))));
    },
    [slots.length, svgWidth],
  );

  const handleMouseLeave = useCallback(() => setHoverIndex(null), []);

  return (
    <section className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white/85 shadow-[0_30px_80px_-40px_rgba(15,23,42,0.45)] backdrop-blur">
      <div className="border-b border-slate-200 px-6 py-5 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">Band average decay</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">NIFTY band average</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Average CE and PE decay across ATM ± 5 ITM strikes (11-strike band, 50-pt step).
            </p>
          </div>
          <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-600">
            Band: <span className="font-semibold text-slate-900">ATM ± 250</span>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">CE avg decay</span>
          <span className="rounded-full bg-rose-50 px-3 py-1 font-medium text-rose-700">PE avg decay</span>
          <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600">
            {loading ? "Loading live rows..." : isDemo ? "Demo curve until live data arrives" : "Realtime feed active"}
          </span>
          {latest && !isDemo ? (
            <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600">
              Last sample {formatPremiumDecayTime(latest.sampledAt)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="px-4 pb-4 pt-2 sm:px-6">
        <div className="grid gap-3 border-b border-slate-100 pb-4 text-sm text-slate-500 sm:grid-cols-3">
          <div>
            <span className="block text-xs uppercase tracking-[0.2em] text-slate-400">Status</span>
            <span className="mt-1 block font-medium text-slate-900">
              {error ? "Feed error" : loading ? "Syncing" : "Streaming"}
            </span>
          </div>
          <div>
            <span className="block text-xs uppercase tracking-[0.2em] text-slate-400">Band</span>
            <span className="mt-1 block font-medium text-slate-900">
              {latest ? `${(latest.strike - 250).toLocaleString("en-IN")} – ${(latest.strike + 250).toLocaleString("en-IN")}` : "—"}
            </span>
          </div>
          <div>
            <span className="block text-xs uppercase tracking-[0.2em] text-slate-400">Underlying</span>
            <span className="mt-1 block font-medium text-slate-900">
              {latest ? latest.underlyingLtp.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"}
            </span>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Supabase query failed: {error}
          </div>
        ) : null}

        <div ref={scrollRef} className="mt-4 overflow-x-auto rounded-[1rem] border border-slate-100 bg-gradient-to-b from-slate-50 to-white">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${svgWidth} ${SVG_HEIGHT}`}
            className="block h-auto max-w-none cursor-crosshair"
            style={{ width: `${svgWidth}px`, minWidth: `${BASE_SVG_WIDTH}px` }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              <linearGradient id="band-ce-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0.15" />
              </linearGradient>
              <linearGradient id="band-pe-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.15" />
              </linearGradient>
              <clipPath id="band-average-plot-clip">
                <rect {...plotClipRect} />
              </clipPath>
            </defs>

            {yTicks.map((tick) => {
              const y = sy(tick, metrics);
              return (
                <g key={`y-${tick}`}>
                  <line x1={MARGIN.left} x2={svgWidth - MARGIN.right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="6 8" />
                  <text x={MARGIN.left - 12} y={y + 4} fill="#64748b" fontSize="12" textAnchor="end">
                    {Math.round(tick).toLocaleString("en-IN")}
                  </text>
                </g>
              );
            })}

            <line x1={MARGIN.left} x2={svgWidth - MARGIN.right} y1={zeroY} y2={zeroY} stroke="#0f172a" strokeWidth="1.5" />

            <g clipPath="url(#band-average-plot-clip)">
              <path d={ceArea} fill="url(#band-ce-gradient)" />
              <path d={peArea} fill="url(#band-pe-gradient)" />
              <path d={ceLine} fill="none" stroke="#10b981" strokeWidth="1.25" />
              <path d={peLine} fill="none" stroke="#ef4444" strokeWidth="1.25" />
            </g>

            {slots.map((slot, index) => {
              const x = sx(index, slots.length, metrics);
              return (
                <g key={`x-${slot.minuteKey}`}>
                  <line x1={x} x2={x} y1={SVG_HEIGHT - MARGIN.bottom} y2={SVG_HEIGHT - MARGIN.bottom + 8} stroke="#cbd5e1" />
                  {timeTickIndices.has(index) ? (
                    <text x={x} y={SVG_HEIGHT - 24} fill="#64748b" fontSize="12" textAnchor="middle">
                      {formatPremiumDecayTime(slot.sampledAt)}
                    </text>
                  ) : null}
                </g>
              );
            })}

            <text x={16} y={MARGIN.top + 18} fill="#10b981" fontSize="13" fontWeight="600">CE avg</text>
            <text x={16} y={MARGIN.top + 40} fill="#ef4444" fontSize="13" fontWeight="600">PE avg</text>

            {hoverIndex !== null && slots[hoverIndex] ? (() => {
              const slot = slots[hoverIndex];
              const x = sx(hoverIndex, slots.length, metrics);
              const ceY = sy(slot.ceDecay, metrics);
              const peY = sy(slot.chartPeDecay, metrics);
              const timeLabel = formatPremiumDecayTime(slot.sampledAt);
              const ceLabel = `${slot.ceDecay >= 0 ? "+" : ""}${slot.ceDecay.toFixed(1)}`;
              const peLabel = `${slot.peDecay >= 0 ? "+" : ""}${slot.peDecay.toFixed(1)}`;
              const TOOLTIP_W = 140;
              const TOOLTIP_H = 80;
              const tooltipX = x > metrics.left + metrics.width * 0.65 ? x - TOOLTIP_W - 14 : x + 14;
              const tooltipY = MARGIN.top + 6;

              return (
                <g style={{ pointerEvents: "none" }}>
                  <line x1={x} x2={x} y1={MARGIN.top} y2={SVG_HEIGHT - MARGIN.bottom} stroke="#475569" strokeWidth="1" strokeDasharray="4 4" />
                  <circle cx={x} cy={ceY} r="5" fill="#10b981" stroke="white" strokeWidth="2" />
                  <circle cx={x} cy={peY} r="5" fill="#ef4444" stroke="white" strokeWidth="2" />
                  <rect x={tooltipX} y={tooltipY} width={TOOLTIP_W} height={TOOLTIP_H} rx="7" ry="7" fill="#0f172a" opacity="0.93" />
                  <text x={tooltipX + 12} y={tooltipY + 18} fill="#94a3b8" fontSize="11" fontWeight="500">{timeLabel}</text>
                  <line x1={tooltipX + 6} x2={tooltipX + TOOLTIP_W - 6} y1={tooltipY + 24} y2={tooltipY + 24} stroke="#1e293b" strokeWidth="1" />
                  <circle cx={tooltipX + 15} cy={tooltipY + 38} r="4" fill="#10b981" />
                  <text x={tooltipX + 26} y={tooltipY + 43} fill="#6ee7b7" fontSize="11">CE avg</text>
                  <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 43} fill="#10b981" fontSize="12" fontWeight="700" textAnchor="end">{ceLabel}</text>
                  <circle cx={tooltipX + 15} cy={tooltipY + 60} r="4" fill="#ef4444" />
                  <text x={tooltipX + 26} y={tooltipY + 65} fill="#fca5a5" fontSize="11">PE avg</text>
                  <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 65} fill="#ef4444" fontSize="12" fontWeight="700" textAnchor="end">{peLabel}</text>
                </g>
              );
            })() : null}
          </svg>
        </div>
      </div>
    </section>
  );
}
