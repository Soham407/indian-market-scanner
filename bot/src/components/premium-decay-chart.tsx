"use client";

import { useEffect, useMemo, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import {
  buildReadableTimeTickIndices,
  buildLinearPremiumDecayPath,
  buildOneMinutePremiumDecaySeries,
  buildDemoPremiumDecayRows,
  formatPremiumDecayTime,
  normalizePremiumDecayRows,
  type PremiumDecayMinutePoint,
  type PremiumDecayPoint,
  type PremiumDecayRow,
} from "@/lib/premium-decay";

type PremiumDecayChartProps = {
  seriesKey: string;
  title?: string;
  subtitle?: string;
  maxPoints?: number;
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

const SVG_WIDTH = 1000;
const SVG_HEIGHT = 420;
const MARGIN = { top: 28, right: 28, bottom: 56, left: 68 };

function buildChartMetrics(points: PremiumDecayPoint[]): ChartMetrics {
  const values = points.flatMap((point) => [point.ceDecay, point.chartPeDecay, 0]);
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
    width: SVG_WIDTH - MARGIN.left - MARGIN.right,
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

function buildAreaPath(
  slots: PremiumDecayMinutePoint[],
  metrics: ChartMetrics,
  key: "ceDecay" | "chartPeDecay",
): string {
  if (slots.length === 0) return "";

  const baselineY = scaleY(0, metrics);
  const firstX = scaleX(0, slots.length, metrics);
  const lastX = scaleX(slots.length - 1, slots.length, metrics);
  return `M ${firstX.toFixed(2)},${baselineY.toFixed(2)} ${buildLinePath(slots, metrics, key)} L ${lastX.toFixed(2)},${baselineY.toFixed(2)} Z`;
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

function renderPlaceholderSeries(seriesKey: string): PremiumDecayPoint[] {
  return normalizePremiumDecayRows(buildDemoPremiumDecayRows(seriesKey));
}

export function PremiumDecayChart({
  seriesKey,
  title = "Premium Decay",
  subtitle = "Live CE and PE decay streamed from Supabase",
  maxPoints = 120,
}: PremiumDecayChartProps) {
  const [rows, setRows] = useState<PremiumDecayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    const supabase = getBrowserSupabaseClient();

    const loadRows = async () => {
      setLoading(true);
      setError(null);

      const { data, error: queryError } = await supabase
        .from("bot_premium_decay_points")
        .select("id, series_key, instrument_symbol, expiry_date, strike, sampled_at, underlying_ltp, ce_decay, pe_decay")
        .eq("series_key", seriesKey)
        .order("sampled_at", { ascending: false })
        .limit(maxPoints);

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
    const refreshInterval = setInterval(() => {
      void loadRows();
    }, 30_000);

    const channel = supabase
      .channel(`premium-decay-${seriesKey}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "bot_premium_decay_points",
          filter: `series_key=eq.${seriesKey}`,
        },
        (payload) => {
          const nextRow = payload.new as PremiumDecayRow;
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
  }, [maxPoints, seriesKey]);

  const points = useMemo(() => {
    const normalized = normalizePremiumDecayRows(rows);
    return normalized.length > 0 ? normalized : renderPlaceholderSeries(seriesKey);
  }, [rows, seriesKey]);

  const latest = points.at(-1);
  const metrics = useMemo(() => buildChartMetrics(points), [points]);
  const minuteSlots = useMemo(() => buildOneMinutePremiumDecaySeries(points), [points]);
  const timeTickIndices = useMemo(
    () => new Set(buildReadableTimeTickIndices(minuteSlots.length, SVG_WIDTH - MARGIN.left - MARGIN.right)),
    [minuteSlots.length],
  );
  const zeroY = scaleY(0, metrics);
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

  return (
    <section className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white/85 shadow-[0_30px_80px_-40px_rgba(15,23,42,0.45)] backdrop-blur">
      <div className="border-b border-slate-200 px-6 py-5 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">Intraday premium decay</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{subtitle}</p>
          </div>
          <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-600">
            Series: <span className="font-semibold text-slate-900">{seriesKey}</span>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">CE premium movement</span>
          <span className="rounded-full bg-rose-50 px-3 py-1 font-medium text-rose-700">PE premium movement</span>
          <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600">
            {loading ? "Loading live rows..." : points.length > rows.length ? "Demo curve until live data arrives" : "Realtime feed active"}
          </span>
          {latest ? (
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
            <span className="block text-xs uppercase tracking-[0.2em] text-slate-400">Strike</span>
            <span className="mt-1 block font-medium text-slate-900">
              {latest ? latest.strike.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : "—"}
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

        <div className="mt-4 overflow-hidden rounded-[1rem] border border-slate-100 bg-gradient-to-b from-slate-50 to-white">
          <svg viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} className="block h-auto w-full">
            <defs>
              <linearGradient id="ce-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0.15" />
              </linearGradient>
              <linearGradient id="pe-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.15" />
              </linearGradient>
            </defs>

            {yTicks.map((tick) => {
              const y = scaleY(tick, metrics);
              return (
                <g key={`y-${tick}`}>
                  <line x1={MARGIN.left} x2={SVG_WIDTH - MARGIN.right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="6 8" />
                  <text x={MARGIN.left - 12} y={y + 4} fill="#64748b" fontSize="12" textAnchor="end">
                    {Math.round(tick).toLocaleString("en-IN")}
                  </text>
                </g>
              );
            })}

            <line x1={MARGIN.left} x2={SVG_WIDTH - MARGIN.right} y1={zeroY} y2={zeroY} stroke="#0f172a" strokeWidth="1.5" />

            <path d={ceArea} fill="url(#ce-gradient)" />
            <path d={peArea} fill="url(#pe-gradient)" />
            <path d={ceLine} fill="none" stroke="#10b981" strokeWidth="2.75" />
            <path d={peLine} fill="none" stroke="#ef4444" strokeWidth="2.75" />

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
          </svg>
        </div>
      </div>
    </section>
  );
}
