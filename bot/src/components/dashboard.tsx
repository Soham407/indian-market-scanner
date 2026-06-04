"use client";

import { useEffect, useMemo, useState } from "react";
import { BandAverageChart } from "@/components/band-average-chart";
import { PremiumDecayChart } from "@/components/premium-decay-chart";
import { MarqueeBanner } from "@/components/marquee-banner";
import { getHeartbeatStatus, getPremiumDecayCollectorStatus } from "@/lib/heartbeat";
import {
  DEFAULT_OPTIONS_DASHBOARD_MODE,
  DEFAULT_OPTIONS_CHART_MODE,
  getOptionsChartVisibility,
  type OptionsChartMode,
  type OptionsDashboardMode,
} from "@/lib/options-chart-ui";
import {
  classifyPcr,
  computePcr,
  getHighestOiStrike,
  getNiftyMidValue,
  sumOi,
  type OiStrikeRow,
  type PcrClassification,
} from "@/lib/oi-analysis";
import { filterCompletedSessionDates, toIstDateKey } from "@/lib/premium-decay";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";
import { isNseMarketOpen, fmtIstTime } from "@/lib/market-hours";
import type { MarqueeRequest } from "@/app/api/marquee/route";

type BotSettingsRow = {
  last_heartbeat_at: string | null;
  premium_decay_last_sample_at: string | null;
  premium_decay_last_error_at: string | null;
  premium_decay_last_error_message: string | null;
  nifty_previous_open: number | null;
  nifty_previous_high: number | null;
  nifty_previous_low: number | null;
  nifty_previous_close: number | null;
  nifty_current_ltp: number | null;
};

type PremiumDecaySessionRow = { session_date: string };

const PCR_ARROW: Record<PcrClassification, string> = { bullish: "↑", bearish: "↓", neutral: "→" };

function fmtNum(val: number | null): string {
  if (val === null) return "—";
  return val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtStrike(val: number | null): string {
  if (val === null) return "—";
  return val.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function fmtOiLakhs(val: number): string {
  return `${(val / 100_000).toFixed(1)}L`;
}

function formatSessionDate(sessionDate: string): string {
  return new Date(`${sessionDate}T00:00:00+05:30`).toLocaleDateString("en-IN", {
    dateStyle: "medium",
    timeZone: "Asia/Kolkata",
  });
}

type StatusDotProps = { alive: boolean; standby?: boolean; label: string; sub: string };

function StatusDot({ alive, standby, label, sub }: StatusDotProps) {
  const color = standby
    ? "bg-zinc-400"
    : alive
      ? "bg-emerald-500"
      : "bg-rose-500";
  return (
    <div className="flex items-center gap-1.5" title={sub}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
      <span className="text-xs font-semibold text-zinc-900">{label}</span>
    </div>
  );
}

export function Dashboard() {
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [premiumDecayLastSampleAt, setPremiumDecayLastSampleAt] = useState<string | null>(null);
  const [premiumDecayLastErrorAt, setPremiumDecayLastErrorAt] = useState<string | null>(null);
  const [premiumDecayLastErrorMessage, setPremiumDecayLastErrorMessage] = useState<string | null>(null);
  const [niftyPrevOpen, setNiftyPrevOpen] = useState<number | null>(null);
  const [niftyPrevHigh, setNiftyPrevHigh] = useState<number | null>(null);
  const [niftyPrevLow, setNiftyPrevLow] = useState<number | null>(null);
  const [niftyPrevClose, setNiftyPrevClose] = useState<number | null>(null);
  const [niftyCurrentLtp, setNiftyCurrentLtp] = useState<number | null>(null);
  const [oiRows, setOiRows] = useState<OiStrikeRow[]>([]);
  const [oiLastUpdated, setOiLastUpdated] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [dashboardMode, setDashboardMode] = useState<OptionsDashboardMode>(DEFAULT_OPTIONS_DASHBOARD_MODE);
  const [chartMode, setChartMode] = useState<OptionsChartMode>(DEFAULT_OPTIONS_CHART_MODE);
  const [historicalSessionDates, setHistoricalSessionDates] = useState<string[]>([]);
  const [selectedHistoricalSessionDate, setSelectedHistoricalSessionDate] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [showAllStrikes, setShowAllStrikes] = useState(false);

  const status = useMemo(() => getHeartbeatStatus(lastHeartbeatAt, now), [lastHeartbeatAt, now]);
  const collectorStatus = useMemo(
    () => getPremiumDecayCollectorStatus(premiumDecayLastSampleAt, premiumDecayLastErrorAt, premiumDecayLastErrorMessage, now),
    [now, premiumDecayLastErrorAt, premiumDecayLastErrorMessage, premiumDecayLastSampleAt],
  );
  const chartVisibility = getOptionsChartVisibility(chartMode);
  const liveSessionDate = toIstDateKey(now);
  const selectedSessionDate = dashboardMode === "live" ? liveSessionDate : selectedHistoricalSessionDate;

  // PCR + OI derived values
  const totalCeOi = useMemo(() => sumOi(oiRows, "ce"), [oiRows]);
  const totalPeOi = useMemo(() => sumOi(oiRows, "pe"), [oiRows]);
  const pcr = useMemo(() => computePcr(totalPeOi, totalCeOi), [totalPeOi, totalCeOi]);
  const pcrClass = useMemo(() => (pcr !== null ? classifyPcr(pcr) : null), [pcr]);
  const ceMax = useMemo(() => getHighestOiStrike(oiRows, "ce"), [oiRows]);
  const peMax = useMemo(() => getHighestOiStrike(oiRows, "pe"), [oiRows]);
  const niftyMid = niftyPrevHigh !== null && niftyPrevLow !== null
    ? getNiftyMidValue(niftyPrevHigh, niftyPrevLow)
    : null;

  const marketOpen = useMemo(() => isNseMarketOpen(now), [now]);

  const atmStrike = useMemo(() => {
    const ref = niftyCurrentLtp ?? niftyPrevClose;
    if (ref === null) return null;
    return Math.round(ref / 50) * 50;
  }, [niftyCurrentLtp, niftyPrevClose]);

  const sortedOiRows = useMemo(() =>
    [...oiRows].sort((a, b) => a.strike - b.strike),
    [oiRows],
  );

  const nearAtmRows = useMemo(() => {
    if (atmStrike === null) return sortedOiRows;
    return sortedOiRows.filter((r) => Math.abs(r.strike - atmStrike) <= 250);
  }, [sortedOiRows, atmStrike]);

  const visibleOiRows = showAllStrikes ? sortedOiRows : nearAtmRows;

  const marqueeCtx = useMemo((): MarqueeRequest => ({
    pcr,
    pcrClass,
    ceMaxOiStrike: ceMax?.strike ?? null,
    peMaxOiStrike: peMax?.strike ?? null,
    niftyPreviousClose: niftyPrevClose,
    niftyPreviousOpen: niftyPrevOpen,
  }), [pcr, pcrClass, ceMax, peMax, niftyPrevClose, niftyPrevOpen]);

  // Clock
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Historical sessions
  useEffect(() => {
    if (dashboardMode !== "historical") return;
    let isActive = true;
    const supabase = getBrowserSupabaseClient();

    const loadHistoricalSessions = async () => {
      setHistoryLoading(true);
      setHistoryError(null);
      const { data, error } = await supabase
        .from("bot_premium_decay_sessions")
        .select("session_date")
        .order("session_date", { ascending: false });
      if (!isActive) return;
      if (error) {
        setHistoryError(error.message);
        setHistoricalSessionDates([]);
        setSelectedHistoricalSessionDate(null);
      } else {
        const dates = filterCompletedSessionDates(
          ((data ?? []) as PremiumDecaySessionRow[]).map((r) => r.session_date),
          new Date(),
        );
        setHistoricalSessionDates(dates);
        setSelectedHistoricalSessionDate((cur) =>
          cur && dates.includes(cur) ? cur : dates[0] ?? null,
        );
      }
      setHistoryLoading(false);
    };

    void loadHistoricalSessions();
    return () => { isActive = false; };
  }, [dashboardMode, liveSessionDate]);

  // Bot settings + Realtime
  useEffect(() => {
    const supabase = getBrowserSupabaseClient();

    const load = async () => {
      const { data } = await supabase
        .from("bot_settings")
        .select("last_heartbeat_at, premium_decay_last_sample_at, premium_decay_last_error_at, premium_decay_last_error_message, nifty_previous_open, nifty_previous_high, nifty_previous_low, nifty_previous_close, nifty_current_ltp")
        .eq("id", 1)
        .single();
      if (data) {
        const row = data as BotSettingsRow;
        setLastHeartbeatAt(row.last_heartbeat_at);
        setPremiumDecayLastSampleAt(row.premium_decay_last_sample_at);
        setPremiumDecayLastErrorAt(row.premium_decay_last_error_at);
        setPremiumDecayLastErrorMessage(row.premium_decay_last_error_message);
        setNiftyPrevOpen(row.nifty_previous_open);
        setNiftyPrevHigh(row.nifty_previous_high);
        setNiftyPrevLow(row.nifty_previous_low);
        setNiftyPrevClose(row.nifty_previous_close);
        setNiftyCurrentLtp(row.nifty_current_ltp);
      }
    };

    void load();

    const channel = supabase
      .channel("bot-settings-main")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "bot_settings", filter: "id=eq.1" },
        (payload) => {
          const row = payload.new as BotSettingsRow;
          setLastHeartbeatAt(row.last_heartbeat_at);
          setPremiumDecayLastSampleAt(row.premium_decay_last_sample_at);
          setPremiumDecayLastErrorAt(row.premium_decay_last_error_at);
          setPremiumDecayLastErrorMessage(row.premium_decay_last_error_message);
          setNiftyPrevOpen(row.nifty_previous_open);
          setNiftyPrevHigh(row.nifty_previous_high);
          setNiftyPrevLow(row.nifty_previous_low);
          setNiftyPrevClose(row.nifty_previous_close);
          setNiftyCurrentLtp(row.nifty_current_ltp);
          setNow(new Date());
        },
      )
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, []);

  // OI chain polling — 30 s during market hours, 5 min outside
  useEffect(() => {
    const supabase = getBrowserSupabaseClient();

    const loadOi = async () => {
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
        setOiRows((data as OiStrikeRow[]).map((r) => ({ strike: r.strike, ce_oi: r.ce_oi, pe_oi: r.pe_oi })));
        setOiLastUpdated(new Date());
      }
    };

    void loadOi();

    // Schedule next poll; re-schedule on each tick so the interval adjusts
    // automatically when the session opens or closes.
    let timeout: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const intervalMs = isNseMarketOpen() ? 30_000 : 5 * 60_000;
      timeout = setTimeout(async () => {
        await loadOi();
        schedule();
      }, intervalMs);
    };
    schedule();

    return () => clearTimeout(timeout);
  }, []);

  const tabBtn = (active: boolean) =>
    `px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
      active ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100"
    }`;

  return (
    <main>
      <div className="flex flex-col">

        {/* ── Header ─────────────────────────────────────────── */}
        <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-1 py-3">
          <div className="flex items-center gap-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-zinc-500">
              Indian Market Scanner
            </span>
            <span className="text-zinc-400" aria-hidden>·</span>
            <h1 className="text-sm font-bold text-zinc-950">NIFTY Options Dashboard</h1>
          </div>
          <div className="flex items-center gap-4">
            {/* Market session pill */}
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide ${
              marketOpen
                ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"
                : "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${marketOpen ? "animate-pulse bg-emerald-500" : "bg-zinc-400"}`} />
              {marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}
            </span>
            <StatusDot
              alive={status.isAlive}
              standby={status.label === "STANDBY"}
              label="Bot"
              sub={status.message}
            />
            <StatusDot
              alive={collectorStatus.label === "ACTIVE"}
              standby={collectorStatus.label === "STANDBY"}
              label="Collector"
              sub={collectorStatus.message}
            />
            <button
              type="button"
              onClick={() => {
                const supabase = getBrowserSupabaseClient();
                void supabase.auth.signOut().then(() => { window.location.href = "/login"; });
              }}
              className="text-xs font-semibold text-zinc-600 transition-colors hover:text-zinc-900"
            >
              Sign out
            </button>
          </div>
        </header>

        {/* ── Marquee ────────────────────────────────────────── */}
        {/* <MarqueeBanner ctx={marqueeCtx} /> */}

        {/* ── Market data panel ──────────────────────────────── */}
        <div className="grid grid-cols-1 divide-y divide-zinc-200 border-b border-zinc-200 bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0">

          {/* PCR */}
          <div className="px-5 py-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-700">PCR</p>
            {pcr !== null && pcrClass !== null ? (
              <div className="mt-1.5">
                <div className="flex items-baseline gap-2">
                  <span className={`text-3xl font-bold tabular-nums leading-none ${
                    pcrClass === "bullish" ? "text-emerald-700"
                    : pcrClass === "bearish" ? "text-rose-700"
                    : "text-zinc-700"
                  }`}>
                    {pcr.toFixed(2)}
                  </span>
                  <span className={`text-xs font-semibold uppercase tracking-wide ${
                    pcrClass === "bullish" ? "text-emerald-600"
                    : pcrClass === "bearish" ? "text-rose-600"
                    : "text-zinc-500"
                  }`}>
                    {PCR_ARROW[pcrClass]} {pcrClass}
                  </span>
                </div>
                {oiLastUpdated && (
                  <p className="mt-1 text-[11px] text-zinc-400">as of {fmtIstTime(oiLastUpdated)}</p>
                )}
              </div>
            ) : (
              <div className="mt-2">
                <p className="text-sm font-medium text-zinc-700">
                  {marketOpen ? "Loading OI data…" : "Opens at 9:15 AM IST"}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  {marketOpen ? "Refreshes every 30 s" : "Refreshes every 5 min during session"}
                </p>
              </div>
            )}
          </div>

          {/* Highest OI */}
          <div className="px-5 py-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-700">Highest OI</p>
            {ceMax || peMax ? (
              <div className="mt-1.5">
                <div className="flex gap-6">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xs font-bold text-emerald-700">CE</span>
                    <span className="text-xl font-bold tabular-nums leading-none text-zinc-950">
                      {fmtStrike(ceMax?.strike ?? null)}
                    </span>
                    {ceMax && (
                      <span className="text-[11px] font-medium text-zinc-600">{fmtOiLakhs(ceMax.oi)}</span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xs font-bold text-rose-700">PE</span>
                    <span className="text-xl font-bold tabular-nums leading-none text-zinc-950">
                      {fmtStrike(peMax?.strike ?? null)}
                    </span>
                    {peMax && (
                      <span className="text-[11px] font-medium text-zinc-600">{fmtOiLakhs(peMax.oi)}</span>
                    )}
                  </div>
                </div>
                {oiLastUpdated && (
                  <p className="mt-1 text-[11px] text-zinc-400">as of {fmtIstTime(oiLastUpdated)}</p>
                )}
              </div>
            ) : (
              <div className="mt-2">
                <p className="text-sm font-medium text-zinc-700">
                  {marketOpen ? "Loading OI data…" : "Opens at 9:15 AM IST"}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  {marketOpen ? "Refreshes every 30 s" : "Data from next session"}
                </p>
              </div>
            )}
          </div>

            {/* Nifty current + yesterday */}
          <div className="px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-700">Nifty 50</p>
                {niftyCurrentLtp !== null ? (
                  <p className="mt-1 text-2xl font-bold tabular-nums leading-none text-zinc-950">
                    {niftyCurrentLtp.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                ) : (
                  <p className="mt-1 text-2xl font-bold tabular-nums leading-none text-zinc-300">—</p>
                )}
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  {marketOpen ? "Live spot" : "Last close"}
                </p>
              </div>
              <div className="shrink-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-700">Yesterday</p>
                <div className="mt-1.5 flex flex-col gap-0.5">
                  {(
                    [
                      { label: "O", value: fmtNum(niftyPrevOpen), color: "text-zinc-950" },
                      { label: "H", value: fmtNum(niftyPrevHigh), color: "text-emerald-700" },
                      { label: "L", value: fmtNum(niftyPrevLow), color: "text-rose-700" },
                      { label: "C", value: fmtNum(niftyPrevClose), color: "text-zinc-950" },
                      { label: "Mid", value: fmtNum(niftyMid), color: "text-violet-700" },
                    ] as const
                  ).map(({ label, value, color }) => (
                    <span key={label} className="text-[11px] font-medium text-zinc-500">
                      {label}{" "}
                      <strong className={`font-semibold tabular-nums ${color}`}>{value}</strong>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* ── Chart controls ─────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-3">
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
            <button type="button" aria-pressed={dashboardMode === "live"} onClick={() => setDashboardMode("live")} className={tabBtn(dashboardMode === "live")}>
              Live
            </button>
            <button type="button" aria-pressed={dashboardMode === "historical"} onClick={() => setDashboardMode("historical")} className={tabBtn(dashboardMode === "historical")}>
              Historical
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
            <button type="button" aria-pressed={chartMode === "atm"} onClick={() => setChartMode("atm")} className={tabBtn(chartMode === "atm")}>
              ATM decay
            </button>
            <button type="button" aria-pressed={chartMode === "band-average"} onClick={() => setChartMode("band-average")} className={tabBtn(chartMode === "band-average")}>
              Band avg
            </button>
          </div>
        </div>

        {/* Historical session picker — full width above sidebar+chart */}
        {dashboardMode === "historical" && (
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-5 py-3">
            <label htmlFor="historical-session" className="text-xs font-semibold text-zinc-900">
              Session
            </label>
            <select
              id="historical-session"
              value={selectedHistoricalSessionDate ?? ""}
              onChange={(e) => setSelectedHistoricalSessionDate(e.target.value || null)}
              disabled={historyLoading || historicalSessionDates.length === 0}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-400"
            >
              {historicalSessionDates.length === 0 && <option value="">No completed sessions</option>}
              {historicalSessionDates.map((d) => (
                <option key={d} value={d}>{formatSessionDate(d)}</option>
              ))}
            </select>
            {historyLoading && <span className="text-xs font-medium text-zinc-600">Loading…</span>}
            {historyError && <span className="text-xs font-medium text-amber-800">Could not load history: {historyError}</span>}
          </div>
        )}

        {/* ── OI sidebar + Chart ─────────────────────────────── */}
        <div className="flex min-h-0 bg-white">

          {/* OI Chain sidebar */}
          {oiRows.length > 0 && (
            <div className="w-48 shrink-0 border-r border-zinc-200 flex flex-col">
              {/* Sticky header */}
              <div className="sticky top-0 z-10 bg-white border-b border-zinc-100 px-2 pt-3 pb-2">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[0.28em] text-zinc-500">OI Chain</p>
                    {oiLastUpdated && (
                      <p className="text-[9px] text-zinc-400">{fmtIstTime(oiLastUpdated)}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    {selectedStrike !== null && (
                      <button
                        type="button"
                        onClick={() => setSelectedStrike(null)}
                        className="text-[9px] font-semibold text-violet-600 hover:text-violet-900 underline leading-none"
                      >
                        ✕ {selectedStrike.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowAllStrikes((v) => !v)}
                      className="text-[9px] text-zinc-400 hover:text-zinc-700 leading-none"
                    >
                      {showAllStrikes ? "Near ATM" : `All (${sortedOiRows.length})`}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 text-[9px] font-bold uppercase text-zinc-400">
                  <span className="text-emerald-600">CE OI</span>
                  <span className="text-center">Strike</span>
                  <span className="text-right text-rose-600">PE OI</span>
                </div>
              </div>

              {/* Scrollable rows */}
              <div className="overflow-y-auto">
                <table className="w-full">
                  <tbody>
                    {visibleOiRows.map((row) => {
                      const isAtm = atmStrike !== null && row.strike === atmStrike;
                      const isSelected = selectedStrike === row.strike;
                      const rowBg = isSelected
                        ? "bg-violet-50"
                        : isAtm
                          ? "bg-amber-50"
                          : "hover:bg-zinc-50";
                      return (
                        <tr
                          key={row.strike}
                          className={`cursor-pointer transition-colors ${rowBg} ${isSelected ? "outline outline-1 outline-violet-400" : ""}`}
                          onClick={() => {
                            if (chartMode !== "atm") setChartMode("atm");
                            setSelectedStrike((cur) => cur === row.strike ? null : row.strike);
                          }}
                        >
                          <td className="py-0.5 pl-2 text-left text-[11px] font-semibold tabular-nums text-emerald-700">
                            {fmtOiLakhs(row.ce_oi)}
                          </td>
                          <td className={`py-0.5 text-center text-[11px] font-bold tabular-nums ${isAtm ? "text-amber-700" : isSelected ? "text-violet-800" : "text-zinc-900"}`}>
                            {row.strike.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                            {isAtm && <span className="block text-[8px] font-bold text-amber-500 leading-none">ATM</span>}
                          </td>
                          <td className="py-0.5 pr-2 text-right text-[11px] font-semibold tabular-nums text-rose-700">
                            {fmtOiLakhs(row.pe_oi)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Chart area */}
          <div className="flex-1 min-w-0 p-4 sm:p-6">
            {selectedSessionDate && chartVisibility.showAtm && (
              <PremiumDecayChart
                key={`${dashboardMode}-${selectedSessionDate}-atm-${selectedStrike ?? "default"}`}
                seriesKey="NIFTY-ATM-WEEKLY"
                sessionDate={selectedSessionDate}
                live={dashboardMode === "live"}
                overrideStrike={selectedStrike}
                title={dashboardMode === "live" ? "NIFTY ATM premium decay" : `ATM decay — ${formatSessionDate(selectedSessionDate)}`}
                subtitle={
                  selectedStrike != null
                    ? `Strike ${selectedStrike.toLocaleString("en-IN")} — CE and PE premium decay from session baseline.`
                    : dashboardMode === "live"
                      ? "CE and PE movement from session baseline, streamed live."
                      : "Completed intraday CE and PE movement for the selected session."
                }
              />
            )}
            {selectedSessionDate && chartVisibility.showBandAverage && (
              <BandAverageChart
                key={`${dashboardMode}-${selectedSessionDate}-band`}
                sessionDate={selectedSessionDate}
                live={dashboardMode === "live"}
              />
            )}
            {dashboardMode === "historical" && !historyLoading && !historyError && !selectedHistoricalSessionDate && (
              <div className="flex min-h-56 items-center justify-center rounded-lg border border-dashed border-zinc-200 px-6 text-center">
                <div>
                  <p className="text-sm font-semibold text-zinc-700">No completed sessions yet</p>
                  <p className="mt-1 text-xs text-zinc-600">
                    Today&apos;s session will appear after the 00:00 IST rollover.
                  </p>
                </div>
              </div>
            )}
          </div>

        </div>

      </div>
    </main>
  );
}
