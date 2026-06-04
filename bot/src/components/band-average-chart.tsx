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
  toIstMinuteKey,
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

type OiSnapshot = { minuteKey: string; ceOi: number; peOi: number };

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

function makeSecondaryScaleY(values: number[], m: ChartMetrics) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.12, 1);
  const lo = min - pad;
  const hi = max + pad;
  return (v: number) => {
    const range = hi - lo;
    if (range === 0) return m.top + m.height / 2;
    return m.top + m.height - ((v - lo) / range) * m.height;
  };
}

function buildSecondaryLinePath(
  pts: { value: number }[],
  m: ChartMetrics,
  scaleSecY: (v: number) => number,
): string {
  return pts
    .map((pt, i) => {
      const x = sx(i, pts.length, m);
      const y = scaleSecY(pt.value);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function fmtOiShort(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 100_000) return `${(v / 100_000).toFixed(1)}L`;
  return v.toLocaleString("en-IN");
}

function linePath(slots: PremiumDecayMinutePoint[], m: ChartMetrics, key: "ceDecay" | "chartPeDecay"): string {
  return buildLinearPremiumDecayPath(
    slots, key,
    (i) => sx(i, slots.length, m),
    (v) => sy(v, m),
  );
}

function areaPath(slots: PremiumDecayMinutePoint[], m: ChartMetrics, key: "ceDecay" | "chartPeDecay"): string {
  return buildPremiumDecayAreaPath(
    slots, key,
    (i) => sx(i, slots.length, m),
    (v) => sy(v, m),
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
  const [showSpot, setShowSpot] = useState(false);
  const [showOiOverlay, setShowOiOverlay] = useState(false);
  const [oiRawData, setOiRawData] = useState<OiSnapshot[]>([]);
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
        supabase.from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY).gte("sampled_at", bounds.start).lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false }).range(0, 999),
        supabase.from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY).gte("sampled_at", bounds.start).lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false }).range(1000, 1999),
        supabase.from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY).gte("sampled_at", bounds.start).lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false }).range(2000, 2999),
        supabase.from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY).gte("sampled_at", bounds.start).lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false }).range(3000, 3999),
        supabase.from("bot_premium_decay_points")
          .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
          .eq("series_key", BAND_SERIES_KEY).gte("sampled_at", bounds.start).lt("sampled_at", bounds.end)
          .order("sampled_at", { ascending: false }).range(4000, 4999),
      ]);

      if (!isActive) return;

      const allData: PremiumDecayRow[] = [];
      let pageError: string | null = null;
      for (const page of pages) {
        if (page.error) { pageError = page.error.message; break; }
        allData.push(...(page.data ?? []));
      }

      if (pageError) { setError(pageError); setRows([]); }
      else { setRows(allData.reverse() as PremiumDecayRow[]); }
      setLoading(false);
    };

    void loadRows();
    if (!feed.subscribeToRealtime || feed.pollIntervalMs === null) {
      return () => { isActive = false; };
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

    return () => { isActive = false; clearInterval(interval); void supabase.removeChannel(channel); };
  }, [live, sessionDate]);

  // Fetch total CE/PE OI change across all strikes for the session
  useEffect(() => {
    if (!showOiOverlay) { setOiRawData([]); return; }
    let isActive = true;
    const supabase = getBrowserSupabaseClient();

    const fetchOi = async () => {
      const { data } = await supabase
        .from("bot_nifty_oi_chain")
        .select("sampled_at, ce_oi, pe_oi")
        .eq("session_date", sessionDate)
        .order("sampled_at", { ascending: true })
        .limit(10000);

      if (!isActive || !data) return;

      const totals = new Map<string, { ceOi: number; peOi: number }>();
      for (const row of data as { sampled_at: string; ce_oi: number; pe_oi: number }[]) {
        const key = toIstMinuteKey(new Date(row.sampled_at));
        const prev = totals.get(key) ?? { ceOi: 0, peOi: 0 };
        totals.set(key, { ceOi: prev.ceOi + row.ce_oi, peOi: prev.peOi + row.pe_oi });
      }

      const sorted = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
      if (sorted.length === 0) return;
      const baseCe = sorted[0][1].ceOi;
      const basePe = sorted[0][1].peOi;
      setOiRawData(sorted.map(([minuteKey, { ceOi, peOi }]) => ({
        minuteKey, ceOi: ceOi - baseCe, peOi: peOi - basePe,
      })));
    };

    void fetchOi();
    return () => { isActive = false; };
  }, [showOiOverlay, sessionDate]);

  const slots = useMemo(() => buildBandAveragedSeries(rows), [rows]);

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

  // LTP secondary scale + path
  const { ltpLine, scaleLtpY } = useMemo(() => {
    if (!showSpot || slots.length === 0) return { ltpLine: "", scaleLtpY: null };
    const vals = slots.map((s) => s.underlyingLtp).filter((v) => v > 0);
    if (vals.length === 0) return { ltpLine: "", scaleLtpY: null };
    const fn = makeSecondaryScaleY(vals, metrics);
    const path = buildSecondaryLinePath(slots.map((s) => ({ value: s.underlyingLtp })), metrics, fn);
    return { ltpLine: path, scaleLtpY: fn };
  }, [showSpot, slots, metrics]);

  // OI minute slots aligned to band slots
  const oiSlots = useMemo(() => {
    if (!showOiOverlay || oiRawData.length === 0 || slots.length === 0) return [];
    const byMinute = new Map(oiRawData.map((d) => [d.minuteKey, { ceOi: d.ceOi, peOi: d.peOi }]));
    let last = { ceOi: 0, peOi: 0 };
    return slots.map((slot) => {
      const key = toIstMinuteKey(slot.sampledAt);
      const found = byMinute.get(key);
      if (found) last = found;
      return { ...last };
    });
  }, [showOiOverlay, oiRawData, slots]);

  // OI secondary scale + paths
  const { ceOiLine, peOiLine, scaleOiY } = useMemo(() => {
    if (oiSlots.length === 0) return { ceOiLine: "", peOiLine: "", scaleOiY: null };
    const allVals = oiSlots.flatMap((s) => [s.ceOi, s.peOi]);
    const fn = makeSecondaryScaleY(allVals, metrics);
    const ceP = buildSecondaryLinePath(oiSlots.map((s) => ({ value: s.ceOi })), metrics, fn);
    const peP = buildSecondaryLinePath(oiSlots.map((s) => ({ value: s.peOi })), metrics, fn);
    return { ceOiLine: ceP, peOiLine: peP, scaleOiY: fn };
  }, [oiSlots, metrics]);

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

  const togglePill = (active: boolean) =>
    `flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold cursor-pointer select-none transition-colors ${
      active
        ? "border-zinc-700 bg-zinc-900 text-white"
        : "border-zinc-200 bg-zinc-50 text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
    }`;

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

            {/* Spot toggle */}
            <button type="button" onClick={() => setShowSpot((v) => !v)} className={togglePill(showSpot)} title="Overlay NIFTY spot price">
              <span className="h-2 w-2 rounded-full bg-zinc-500" />Spot
            </button>

            {/* OI toggle */}
            <button type="button" onClick={() => setShowOiOverlay((v) => !v)} className={togglePill(showOiOverlay)} title="Overlay total CE/PE OI change">
              <span className="h-2 w-2 rounded-full bg-violet-500" />OI
            </button>

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

              {/* LTP spot overlay */}
              {showSpot && ltpLine && (
                <path d={ltpLine} fill="none" stroke="#334155" strokeWidth="1.5" />
              )}

              {/* OI overlay lines */}
              {showOiOverlay && ceOiLine && (
                <path d={ceOiLine} fill="none" stroke="#10b981" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.8" />
              )}
              {showOiOverlay && peOiLine && (
                <path d={peOiLine} fill="none" stroke="#f43f5e" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.8" />
              )}
            </g>

            {/* LTP right-edge label */}
            {showSpot && scaleLtpY && slots.length > 0 && (() => {
              const lastLtp = slots.at(-1)!.underlyingLtp;
              const y = scaleLtpY(lastLtp);
              return (
                <g>
                  <rect x={svgWidth - 52} y={y - 9} width={52} height={14} fill="#334155" rx="2" />
                  <text x={svgWidth - 3} y={y + 2} fill="white" fontSize="9" fontWeight="700" textAnchor="end">
                    {Math.round(lastLtp).toLocaleString("en-IN")}
                  </text>
                </g>
              );
            })()}

            {/* OI right-edge labels */}
            {showOiOverlay && scaleOiY && oiSlots.length > 0 && (() => {
              const last = oiSlots.at(-1)!;
              const cY = scaleOiY(last.ceOi);
              const pY = scaleOiY(last.peOi);
              return (
                <g>
                  <text x={svgWidth - MARGIN.right + 3} y={cY + 3} fill="#10b981" fontSize="9" fontWeight="700">{fmtOiShort(last.ceOi)}</text>
                  <text x={svgWidth - MARGIN.right + 3} y={pY + 3} fill="#f43f5e" fontSize="9" fontWeight="700">{fmtOiShort(last.peOi)}</text>
                </g>
              );
            })()}

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

              const extraRows = (showSpot ? 1 : 0) + (showOiOverlay && oiSlots[hoverIndex] ? 1 : 0);
              const TOOLTIP_W = 160;
              const TOOLTIP_H = 82 + extraRows * 22;
              const tooltipX = x > metrics.left + metrics.width * 0.65 ? x - TOOLTIP_W - 14 : x + 14;
              const tooltipY = MARGIN.top + 6;

              return (
                <g style={{ pointerEvents: "none" }}>
                  <line x1={x} x2={x} y1={MARGIN.top} y2={SVG_HEIGHT - MARGIN.bottom} stroke="#475569" strokeWidth="1" strokeDasharray="4 4" />
                  <circle cx={x} cy={ceY} r="5" fill="#10b981" stroke="white" strokeWidth="2" />
                  <circle cx={x} cy={peY} r="5" fill="#ef4444" stroke="white" strokeWidth="2" />
                  {showSpot && scaleLtpY && (
                    <circle cx={x} cy={scaleLtpY(slot.underlyingLtp)} r="4" fill="#334155" stroke="white" strokeWidth="2" />
                  )}

                  <rect x={tooltipX} y={tooltipY} width={TOOLTIP_W} height={TOOLTIP_H} rx="7" ry="7" fill="#0f172a" opacity="0.93" />
                  <text x={tooltipX + 12} y={tooltipY + 18} fill="#94a3b8" fontSize="11" fontWeight="500">{timeLabel}</text>
                  <line x1={tooltipX + 6} x2={tooltipX + TOOLTIP_W - 6} y1={tooltipY + 24} y2={tooltipY + 24} stroke="#1e293b" strokeWidth="1" />

                  <circle cx={tooltipX + 15} cy={tooltipY + 38} r="4" fill="#10b981" />
                  <text x={tooltipX + 26} y={tooltipY + 43} fill="#6ee7b7" fontSize="11">CE avg</text>
                  <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 43} fill="#10b981" fontSize="12" fontWeight="700" textAnchor="end">{ceLabel}</text>

                  <circle cx={tooltipX + 15} cy={tooltipY + 60} r="4" fill="#ef4444" />
                  <text x={tooltipX + 26} y={tooltipY + 65} fill="#fca5a5" fontSize="11">PE avg</text>
                  <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 65} fill="#ef4444" fontSize="12" fontWeight="700" textAnchor="end">{peLabel}</text>

                  {showSpot && (
                    <>
                      <circle cx={tooltipX + 15} cy={tooltipY + 78} r="4" fill="#334155" />
                      <text x={tooltipX + 26} y={tooltipY + 83} fill="#94a3b8" fontSize="11">Spot</text>
                      <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 83} fill="#e2e8f0" fontSize="11" fontWeight="700" textAnchor="end">
                        {slot.underlyingLtp.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </text>
                    </>
                  )}

                  {showOiOverlay && oiSlots[hoverIndex] && (() => {
                    const oiRowY = tooltipY + 78 + (showSpot ? 22 : 0);
                    const oi = oiSlots[hoverIndex];
                    return (
                      <>
                        <circle cx={tooltipX + 15} cy={oiRowY} r="4" fill="#8b5cf6" />
                        <text x={tooltipX + 26} y={oiRowY + 5} fill="#c4b5fd" fontSize="11">OI Δ</text>
                        <text x={tooltipX + TOOLTIP_W - 12} y={oiRowY + 5} fill="#c4b5fd" fontSize="10" fontWeight="700" textAnchor="end">
                          CE {fmtOiShort(oi.ceOi)} / PE {fmtOiShort(oi.peOi)}
                        </text>
                      </>
                    );
                  })()}
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
