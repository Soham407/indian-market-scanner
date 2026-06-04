"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import {
  buildReadableTimeTickIndices,
  buildPremiumDecayAreaPath,
  buildLinearPremiumDecayPath,
  buildOneMinutePremiumDecaySeries,
  formatPremiumDecayTime,
  getIstSessionBounds,
  keepLatestIstSessionPoints,
  normalizePremiumDecayRows,
  toIstMinuteKey,
  type PremiumDecayMinutePoint,
  type PremiumDecayPoint,
  type PremiumDecayRow,
} from "@/lib/premium-decay";
import {
  NSE_SESSION_MINUTE_COUNT,
  PREMIUM_DECAY_BAND_SERIES_KEY,
  getPremiumDecayDataState,
  getPremiumDecayFeedBehavior,
  getPremiumDecayMetricValues,
  getPremiumDecayPlotClipRect,
  getPremiumDecaySvgWidth,
} from "@/lib/options-chart-ui";

type PremiumDecayChartProps = {
  seriesKey: string;
  sessionDate: string;
  live: boolean;
  title?: string;
  subtitle?: string;
  maxPoints?: number;
  overrideStrike?: number | null;
};

type ChartMetrics = {
  minY: number;
  maxY: number;
  zeroY: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type OiSnapshot = { minuteKey: string; ceOi: number; peOi: number };

const BASE_SVG_WIDTH = 1000;
const SVG_HEIGHT = 420;
const MARGIN = { top: 28, right: 28, bottom: 56, left: 68 };

function buildChartMetrics(points: PremiumDecayPoint[], svgWidth: number): ChartMetrics {
  const values = getPremiumDecayMetricValues(points);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(5, (rawMax - rawMin) * 0.15);
  const minY = rawMin - padding;
  const maxY = rawMax + padding;

  return {
    minY,
    maxY,
    zeroY: 0,
    left: MARGIN.left,
    top: MARGIN.top,
    width: svgWidth - MARGIN.left - MARGIN.right,
    height: SVG_HEIGHT - MARGIN.top - MARGIN.bottom,
  };
}

function scaleX(index: number, total: number, metrics: ChartMetrics): number {
  if (total <= 1) {
    return metrics.left + metrics.width / 2;
  }
  return metrics.left + (index / (total - 1)) * metrics.width;
}

function scaleY(value: number, metrics: ChartMetrics): number {
  const range = metrics.maxY - metrics.minY;
  if (range === 0) {
    return metrics.top + metrics.height / 2;
  }
  const normalized = (value - metrics.minY) / range;
  return metrics.top + metrics.height - normalized * metrics.height;
}

function makeSecondaryScaleY(values: number[], metrics: ChartMetrics) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.12, 1);
  const lo = min - pad;
  const hi = max + pad;
  return (v: number) => {
    const range = hi - lo;
    if (range === 0) return metrics.top + metrics.height / 2;
    return metrics.top + metrics.height - ((v - lo) / range) * metrics.height;
  };
}

function buildAreaPath(
  slots: PremiumDecayMinutePoint[],
  metrics: ChartMetrics,
  key: "ceDecay" | "chartPeDecay",
): string {
  return buildPremiumDecayAreaPath(
    slots,
    key,
    (index) => scaleX(index, slots.length, metrics),
    (value) => scaleY(value, metrics),
  );
}

function buildLinePath(
  slots: PremiumDecayMinutePoint[],
  metrics: ChartMetrics,
  key: "ceDecay" | "chartPeDecay",
): string {
  return buildLinearPremiumDecayPath(
    slots,
    key,
    (index) => scaleX(index, slots.length, metrics),
    (value) => scaleY(value, metrics),
  );
}

function buildSecondaryLinePath(
  slots: { value: number }[],
  metrics: ChartMetrics,
  scaleSecY: (v: number) => number,
): string {
  return slots
    .map((pt, i) => {
      const x = scaleX(i, slots.length, metrics);
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

export function PremiumDecayChart({
  seriesKey,
  sessionDate,
  live,
  title = "Premium Decay",
  subtitle = "Live CE and PE decay streamed from Supabase",
  maxPoints = NSE_SESSION_MINUTE_COUNT,
  overrideStrike = null,
}: PremiumDecayChartProps) {
  const [rows, setRows] = useState<PremiumDecayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showSpot, setShowSpot] = useState(false);
  const [showOiOverlay, setShowOiOverlay] = useState(false);
  const [oiRawData, setOiRawData] = useState<OiSnapshot[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const effectiveSeriesKey = overrideStrike != null ? PREMIUM_DECAY_BAND_SERIES_KEY : seriesKey;

  useEffect(() => {
    let isActive = true;
    const supabase = getBrowserSupabaseClient();
    const bounds = getIstSessionBounds(sessionDate);
    const feed = getPremiumDecayFeedBehavior(live);

    const loadRows = async () => {
      setLoading(true);
      setError(null);

      let query = supabase
        .from("bot_premium_decay_points")
        .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
        .eq("series_key", effectiveSeriesKey)
        .gte("sampled_at", bounds.start)
        .lt("sampled_at", bounds.end)
        .order("sampled_at", { ascending: false })
        .limit(maxPoints);

      if (overrideStrike != null) {
        query = query.eq("strike", overrideStrike);
      }

      const { data, error: queryError } = await query;

      if (!isActive) {
        return;
      }

      if (queryError) {
        setError(queryError.message);
        setRows([]);
      } else {
        setRows((data ?? []) as PremiumDecayRow[]);
      }

      setLoading(false);
    };

    void loadRows();
    if (!feed.subscribeToRealtime || feed.pollIntervalMs === null) {
      return () => {
        isActive = false;
      };
    }

    const refreshInterval = setInterval(() => void loadRows(), feed.pollIntervalMs);

    const channelId = overrideStrike != null
      ? `premium-decay-band-${overrideStrike}-${sessionDate}`
      : `premium-decay-${effectiveSeriesKey}-${sessionDate}`;

    const channel = supabase
      .channel(channelId)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "bot_premium_decay_points",
          filter: `series_key=eq.${effectiveSeriesKey}`,
        },
        (payload) => {
          const nextRow = payload.new as PremiumDecayRow;
          if (overrideStrike != null && Number(nextRow.strike) !== overrideStrike) return;
          const sampledAt = new Date(nextRow.sampled_at).getTime();
          if (sampledAt < new Date(bounds.start).getTime() || sampledAt >= new Date(bounds.end).getTime()) return;

          setRows((current) => {
            const merged = [...current.filter((row) => row.id !== nextRow.id), nextRow];
            merged.sort((a, b) => new Date(a.sampled_at).getTime() - new Date(b.sampled_at).getTime());
            return merged.slice(-maxPoints);
          });
          setError(null);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "bot_premium_decay_points",
        },
        () => {
          void loadRows();
        },
      )
      .subscribe();

    return () => {
      isActive = false;
      clearInterval(refreshInterval);
      void supabase.removeChannel(channel);
    };
  }, [live, maxPoints, effectiveSeriesKey, sessionDate, overrideStrike]);

  // Fetch OI overlay data.
  // When overrideStrike is set: show that specific strike's OI change over the session.
  // Otherwise: show total CE/PE OI change across all strikes (whole-market view).
  useEffect(() => {
    if (!showOiOverlay) {
      setOiRawData([]);
      return;
    }

    let isActive = true;
    const supabase = getBrowserSupabaseClient();

    const fetchOi = async () => {
      let query = supabase
        .from("bot_nifty_oi_chain")
        .select("sampled_at, ce_oi, pe_oi")
        .eq("session_date", sessionDate)
        .order("sampled_at", { ascending: true });

      if (overrideStrike != null) {
        // Per-strike: small result set (~75 snapshots max)
        query = query.eq("strike", overrideStrike).limit(500);
      } else {
        // All strikes: up to ~200 strikes × 75 snapshots = 15,000 rows
        query = query.limit(10000);
      }

      const { data } = await query;
      if (!isActive || !data) return;

      // Group by minute, summing across strikes (no-op when filtered to one strike)
      const totals = new Map<string, { ceOi: number; peOi: number }>();
      for (const row of data as { sampled_at: string; ce_oi: number; pe_oi: number }[]) {
        const key = toIstMinuteKey(new Date(row.sampled_at));
        const prev = totals.get(key) ?? { ceOi: 0, peOi: 0 };
        totals.set(key, { ceOi: prev.ceOi + row.ce_oi, peOi: prev.peOi + row.pe_oi });
      }

      const sortedEntries = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
      if (sortedEntries.length === 0) return;

      const baseCe = sortedEntries[0][1].ceOi;
      const basePe = sortedEntries[0][1].peOi;

      setOiRawData(
        sortedEntries.map(([minuteKey, { ceOi, peOi }]) => ({
          minuteKey,
          ceOi: ceOi - baseCe,
          peOi: peOi - basePe,
        })),
      );
    };

    void fetchOi();
    return () => { isActive = false; };
  }, [showOiOverlay, sessionDate, overrideStrike]);

  const points = useMemo(() => {
    return keepLatestIstSessionPoints(normalizePremiumDecayRows(rows));
  }, [rows]);

  const dataState = getPremiumDecayDataState(points.length);
  const latest = points.at(-1);
  const minuteSlots = useMemo(() => buildOneMinutePremiumDecaySeries(points), [points]);
  const svgWidth = getPremiumDecaySvgWidth(minuteSlots.length);
  const metrics = useMemo(() => buildChartMetrics(points, svgWidth), [points, svgWidth]);
  const timeTickIndices = useMemo(
    () => new Set(buildReadableTimeTickIndices(minuteSlots.length, svgWidth - MARGIN.left - MARGIN.right)),
    [minuteSlots.length, svgWidth],
  );
  const zeroY = scaleY(0, metrics);
  const plotClipRect = getPremiumDecayPlotClipRect(svgWidth);
  const ceArea = buildAreaPath(minuteSlots, metrics, "ceDecay");
  const peArea = buildAreaPath(minuteSlots, metrics, "chartPeDecay");
  const ceLine = buildLinePath(minuteSlots, metrics, "ceDecay");
  const peLine = buildLinePath(minuteSlots, metrics, "chartPeDecay");
  const yTicks = useMemo(() => {
    const tickCount = 5;
    const ticks: number[] = [];
    for (let i = 0; i < tickCount; i += 1) {
      ticks.push(metrics.maxY - (i / (tickCount - 1)) * (metrics.maxY - metrics.minY));
    }
    return ticks;
  }, [metrics.maxY, metrics.minY]);

  // LTP secondary scale + line
  const { ltpLine, scaleLtpY } = useMemo(() => {
    if (!showSpot || minuteSlots.length === 0) return { ltpLine: "", scaleLtpY: null };
    const ltpVals = minuteSlots.map((s) => s.underlyingLtp).filter((v) => v > 0);
    if (ltpVals.length === 0) return { ltpLine: "", scaleLtpY: null };
    const fn = makeSecondaryScaleY(ltpVals, metrics);
    const path = buildSecondaryLinePath(
      minuteSlots.map((s) => ({ value: s.underlyingLtp })),
      metrics,
      fn,
    );
    return { ltpLine: path, scaleLtpY: fn };
  }, [showSpot, minuteSlots, metrics]);

  // OI slots aligned to minuteSlots
  const oiSlots = useMemo(() => {
    if (!showOiOverlay || oiRawData.length === 0 || minuteSlots.length === 0) return [];
    const byMinute = new Map(oiRawData.map((d) => [d.minuteKey, { ceOi: d.ceOi, peOi: d.peOi }]));
    let last = { ceOi: 0, peOi: 0 };
    return minuteSlots.map((slot) => {
      const key = toIstMinuteKey(slot.sampledAt);
      const found = byMinute.get(key);
      if (found) last = found;
      return { ...last };
    });
  }, [showOiOverlay, oiRawData, minuteSlots]);

  // OI secondary scale + lines
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
      if (minuteSlots.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * svgWidth;
      const rawIndex = ((svgX - MARGIN.left) / (svgWidth - MARGIN.left - MARGIN.right)) * (minuteSlots.length - 1);
      setHoverIndex(Math.max(0, Math.min(minuteSlots.length - 1, Math.round(rawIndex))));
    },
    [minuteSlots.length, svgWidth],
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
            <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-700">Intraday premium decay</p>
            <h2 className="mt-1 text-base font-semibold tracking-tight text-zinc-950">
              {title}
              {overrideStrike != null && (
                <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-bold text-violet-800">
                  {overrideStrike.toLocaleString("en-IN")}
                </span>
              )}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />CE
            </span>
            <span className="flex items-center gap-1 text-xs font-medium text-rose-700">
              <span className="h-2 w-2 rounded-full bg-rose-500" />PE
            </span>

            {/* Spot toggle */}
            <button
              type="button"
              onClick={() => setShowSpot((v) => !v)}
              className={togglePill(showSpot)}
              title="Overlay NIFTY spot price"
            >
              <span className="h-2 w-2 rounded-full bg-zinc-500" />
              Spot
            </button>

            {/* OI toggle */}
            <button
              type="button"
              onClick={() => setShowOiOverlay((v) => !v)}
              className={togglePill(showOiOverlay)}
              title="Overlay total CE/PE OI change"
            >
              <span className="h-2 w-2 rounded-full bg-violet-500" />
              OI
            </button>

            <span className="text-xs font-medium text-zinc-700">
              {loading ? "Loading…" : dataState === "waiting" ? "Awaiting market data" : live ? "Live" : "Historical"}
            </span>
            {latest && (
              <span className="text-xs font-medium text-zinc-700">· {formatPremiumDecayTime(latest.sampledAt)}</span>
            )}
          </div>
        </div>
        {subtitle && <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>}
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
              <linearGradient id="ce-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0.15" />
              </linearGradient>
              <linearGradient id="pe-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.15" />
              </linearGradient>
              <clipPath id="premium-decay-plot-clip">
                <rect {...plotClipRect} />
              </clipPath>
            </defs>

            {yTicks.map((tick) => {
              const y = scaleY(tick, metrics);
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

            <g clipPath="url(#premium-decay-plot-clip)">
              <path d={ceArea} fill="url(#ce-gradient)" />
              <path d={peArea} fill="url(#pe-gradient)" />
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
            {showSpot && scaleLtpY && minuteSlots.length > 0 && (() => {
              const lastLtp = minuteSlots.at(-1)!.underlyingLtp;
              const y = scaleLtpY(lastLtp);
              return (
                <g>
                  <rect x={svgWidth - MARGIN.right - 2} y={y - 9} width={MARGIN.right + 2} height={14} fill="#334155" rx="2" />
                  <text
                    x={svgWidth - 2}
                    y={y + 2}
                    fill="white"
                    fontSize="9"
                    fontWeight="700"
                    textAnchor="end"
                  >
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
                  <text x={svgWidth - MARGIN.right + 3} y={cY + 3} fill="#10b981" fontSize="9" fontWeight="700">
                    {fmtOiShort(last.ceOi)}
                  </text>
                  <text x={svgWidth - MARGIN.right + 3} y={pY + 3} fill="#f43f5e" fontSize="9" fontWeight="700">
                    {fmtOiShort(last.peOi)}
                  </text>
                </g>
              );
            })()}

            {minuteSlots.map((slot, index) => {
              const x = scaleX(index, minuteSlots.length, metrics);
              return (
                <g key={`x-${slot.minuteKey}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={MARGIN.top}
                    y2={SVG_HEIGHT - MARGIN.bottom}
                    stroke="transparent"
                    strokeWidth="1"
                  />
                  <line x1={x} x2={x} y1={SVG_HEIGHT - MARGIN.bottom} y2={SVG_HEIGHT - MARGIN.bottom + 8} stroke="#cbd5e1" />
                  {timeTickIndices.has(index) ? (
                    <text x={x} y={SVG_HEIGHT - 24} fill="#64748b" fontSize="12" textAnchor="middle">
                      {formatPremiumDecayTime(slot.sampledAt)}
                    </text>
                  ) : null}
                </g>
              );
            })}

            <text x={16} y={MARGIN.top + 18} fill="#10b981" fontSize="13" fontWeight="600">
              CE
            </text>
            <text x={16} y={MARGIN.top + 40} fill="#ef4444" fontSize="13" fontWeight="600">
              PE
            </text>

            {hoverIndex !== null && minuteSlots[hoverIndex] ? (() => {
              const slot = minuteSlots[hoverIndex];
              const x = scaleX(hoverIndex, minuteSlots.length, metrics);
              const ceY = scaleY(slot.ceDecay, metrics);
              const peY = scaleY(slot.chartPeDecay, metrics);
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
                  <line
                    x1={x} x2={x}
                    y1={MARGIN.top} y2={SVG_HEIGHT - MARGIN.bottom}
                    stroke="#475569" strokeWidth="1" strokeDasharray="4 4"
                  />
                  <circle cx={x} cy={ceY} r="5" fill="#10b981" stroke="white" strokeWidth="2" />
                  <circle cx={x} cy={peY} r="5" fill="#ef4444" stroke="white" strokeWidth="2" />
                  {showSpot && scaleLtpY && (
                    <circle cx={x} cy={scaleLtpY(slot.underlyingLtp)} r="4" fill="#334155" stroke="white" strokeWidth="2" />
                  )}

                  <rect x={tooltipX} y={tooltipY} width={TOOLTIP_W} height={TOOLTIP_H} rx="7" ry="7" fill="#0f172a" opacity="0.93" />
                  <text x={tooltipX + 12} y={tooltipY + 18} fill="#94a3b8" fontSize="11" fontWeight="500">{timeLabel}</text>
                  <line x1={tooltipX + 6} x2={tooltipX + TOOLTIP_W - 6} y1={tooltipY + 24} y2={tooltipY + 24} stroke="#1e293b" strokeWidth="1" />

                  {/* CE row */}
                  <circle cx={tooltipX + 15} cy={tooltipY + 38} r="4" fill="#10b981" />
                  <text x={tooltipX + 26} y={tooltipY + 43} fill="#6ee7b7" fontSize="11">CE</text>
                  <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 43} fill="#10b981" fontSize="12" fontWeight="700" textAnchor="end">{ceLabel}</text>

                  {/* PE row */}
                  <circle cx={tooltipX + 15} cy={tooltipY + 60} r="4" fill="#ef4444" />
                  <text x={tooltipX + 26} y={tooltipY + 65} fill="#fca5a5" fontSize="11">PE</text>
                  <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 65} fill="#ef4444" fontSize="12" fontWeight="700" textAnchor="end">{peLabel}</text>

                  {/* LTP row */}
                  {showSpot && (
                    <>
                      <circle cx={tooltipX + 15} cy={tooltipY + 78} r="4" fill="#334155" />
                      <text x={tooltipX + 26} y={tooltipY + 83} fill="#94a3b8" fontSize="11">Spot</text>
                      <text x={tooltipX + TOOLTIP_W - 12} y={tooltipY + 83} fill="#e2e8f0" fontSize="11" fontWeight="700" textAnchor="end">
                        {slot.underlyingLtp.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </text>
                    </>
                  )}

                  {/* OI row */}
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
