"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import {
  buildBandAveragedSeries,
  buildPremiumDecayAreaPath,
  buildLinearPremiumDecayPath,
  buildReadableTimeTickIndices,
  formatPremiumDecayTime,
  getIstSessionBounds,
  type PremiumDecayMinutePoint,
  type PremiumDecayRow,
} from "@/lib/premium-decay";
import {
  getPremiumDecayDataState,
  getPremiumDecayFeedBehavior,
  getPremiumDecayMetricValues,
  getPremiumDecayPlotClipRect,
  getPremiumDecaySvgWidth,
} from "@/lib/options-chart-ui";

const BAND_SERIES_KEY = "NIFTY-BAND-WEEKLY";
const BAND_ROW_QUERY_LIMIT = 10000;
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
  const values = getPremiumDecayMetricValues(slots);
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

type BandAverageChartProps = {
  sessionDate: string;
  live: boolean;
};

export function BandAverageChart({ sessionDate, live }: BandAverageChartProps) {
  const [rows, setRows] = useState<PremiumDecayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isActive = true;
    const supabase = getBrowserSupabaseClient();
    const bounds = getIstSessionBounds(sessionDate);
    const feed = getPremiumDecayFeedBehavior(live);

    const loadRows = async () => {
      setLoading(true);
      setError(null);
      const pages = await Promise.all([
        supabase
          .from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY)
          .gte("sampled_at", bounds.start)
          .lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false })
          .range(0, 999),
        supabase
          .from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY)
          .gte("sampled_at", bounds.start)
          .lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false })
          .range(1000, 1999),
        supabase
          .from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY)
          .gte("sampled_at", bounds.start)
          .lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false })
          .range(2000, 2999),
        supabase
          .from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY)
          .gte("sampled_at", bounds.start)
          .lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false })
          .range(3000, 3999),
        supabase
          .from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY)
          .gte("sampled_at", bounds.start)
          .lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false })
          .range(4000, 4999),
      ]);

      if (!isActive) return;

      const allData: PremiumDecayRow[] = [];
      let pageError: string | null = null;

      for (const page of pages) {
        if (page.error) {
          pageError = page.error.message;
          break;
        }
        allData.push(...(page.data ?? []));
      }

      if (pageError) {
        setError(pageError);
        setRows([]);
      } else {
        setRows(allData.reverse() as PremiumDecayRow[]);
      }
      setLoading(false);
    };

    void loadRows();
    if (!feed.subscribeToRealtime || feed.pollIntervalMs === null) {
      return () => {
        isActive = false;
      };
    }

    const interval = setInterval(() => void loadRows(), feed.pollIntervalMs);

    const channel = supabase
      .channel("band-average-decay")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "bot_premium_decay_points", filter: `series_key=eq.${BAND_SERIES_KEY}` },
        (payload) => {
          const next = payload.new as PremiumDecayRow;
          const sampledAt = new Date(next.sampled_at).getTime();
          if (sampledAt < new Date(bounds.start).getTime() || sampledAt >= new Date(bounds.end).getTime()) return;

          setRows((cur) => {
            const merged = [...cur.filter((r) => r.id !== next.id), next];
            merged.sort((a, b) => new Date(a.sampled_at).getTime() - new Date(b.sampled_at).getTime());
            return merged.slice(-BAND_ROW_QUERY_LIMIT);
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
  }, [live, sessionDate]);

  const slots = useMemo(() => {
    return buildBandAveragedSeries(rows);
  }, [rows]);

  const dataState = getPremiumDecayDataState(slots.length);
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
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 bg-zinc-50/60 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-700">Band average decay</p>
            <h2 className="mt-1 text-base font-semibold tracking-tight text-zinc-950">NIFTY band average</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-zinc-700">ATM ± 250 pts · 11 strikes</span>
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />CE avg
            </span>
            <span className="flex items-center gap-1 text-xs font-medium text-rose-700">
              <span className="h-2 w-2 rounded-full bg-rose-500" />PE avg
            </span>
            <span className="text-xs font-medium text-zinc-700">
              {loading ? "Loading…" : dataState === "waiting" ? "Awaiting market data" : live ? "Live" : "Historical"}
            </span>
            {latest && (
              <span className="text-xs font-medium text-zinc-700">· {formatPremiumDecayTime(latest.sampledAt)}</span>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 pb-4 pt-3 sm:px-5">
        {error ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            Feed error: {error}
          </div>
        ) : null}

        {dataState === "waiting" && !loading ? (
          <div className="flex min-h-52 items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-6 text-center">
            <div>
              <p className="text-sm font-semibold text-zinc-700">Awaiting market data</p>
              <p className="mt-1 text-xs text-zinc-600">Chart appears after the first market-hours sample.</p>
            </div>
          </div>
        ) : (
        <div ref={scrollRef} className="mt-2 overflow-x-auto rounded-lg border border-zinc-100 bg-zinc-50/40">
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
        )}
      </div>
    </section>
  );
}
