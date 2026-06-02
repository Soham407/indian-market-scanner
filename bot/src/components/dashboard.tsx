"use client";

import { useEffect, useMemo, useState } from "react";
import { BandAverageChart } from "@/components/band-average-chart";
import { PremiumDecayChart } from "@/components/premium-decay-chart";
import { getHeartbeatStatus, getPremiumDecayCollectorStatus } from "@/lib/heartbeat";
import {
  DEFAULT_OPTIONS_DASHBOARD_MODE,
  DEFAULT_OPTIONS_CHART_MODE,
  getOptionsChartVisibility,
  type OptionsChartMode,
  type OptionsDashboardMode,
} from "@/lib/options-chart-ui";
import { filterCompletedSessionDates, toIstDateKey } from "@/lib/premium-decay";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";

type BotSettingsRow = {
  last_heartbeat_at: string | null;
  premium_decay_last_sample_at: string | null;
  premium_decay_last_error_at: string | null;
  premium_decay_last_error_message: string | null;
};

type PremiumDecaySessionRow = {
  session_date: string;
};

function formatSessionDate(sessionDate: string): string {
  return new Date(`${sessionDate}T00:00:00+05:30`).toLocaleDateString("en-IN", {
    dateStyle: "medium",
    timeZone: "Asia/Kolkata",
  });
}

export function Dashboard() {
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [premiumDecayLastSampleAt, setPremiumDecayLastSampleAt] = useState<string | null>(null);
  const [premiumDecayLastErrorAt, setPremiumDecayLastErrorAt] = useState<string | null>(null);
  const [premiumDecayLastErrorMessage, setPremiumDecayLastErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [dashboardMode, setDashboardMode] = useState<OptionsDashboardMode>(DEFAULT_OPTIONS_DASHBOARD_MODE);
  const [chartMode, setChartMode] = useState<OptionsChartMode>(DEFAULT_OPTIONS_CHART_MODE);
  const [historicalSessionDates, setHistoricalSessionDates] = useState<string[]>([]);
  const [selectedHistoricalSessionDate, setSelectedHistoricalSessionDate] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const status = useMemo(() => getHeartbeatStatus(lastHeartbeatAt, now), [lastHeartbeatAt, now]);
  const collectorStatus = useMemo(
    () => getPremiumDecayCollectorStatus(
      premiumDecayLastSampleAt,
      premiumDecayLastErrorAt,
      premiumDecayLastErrorMessage,
      now,
    ),
    [now, premiumDecayLastErrorAt, premiumDecayLastErrorMessage, premiumDecayLastSampleAt],
  );
  const chartVisibility = getOptionsChartVisibility(chartMode);
  const liveSessionDate = toIstDateKey(now);
  const selectedSessionDate = dashboardMode === "live" ? liveSessionDate : selectedHistoricalSessionDate;

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

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
          ((data ?? []) as PremiumDecaySessionRow[]).map((row) => row.session_date),
          new Date(),
        );
        setHistoricalSessionDates(dates);
        setSelectedHistoricalSessionDate((current) => current && dates.includes(current) ? current : dates[0] ?? null);
      }
      setHistoryLoading(false);
    };

    void loadHistoricalSessions();

    return () => {
      isActive = false;
    };
  }, [dashboardMode, liveSessionDate]);

  useEffect(() => {
    const supabase = getBrowserSupabaseClient();

    const load = async () => {
      const { data } = await supabase
        .from("bot_settings")
        .select("last_heartbeat_at, premium_decay_last_sample_at, premium_decay_last_error_at, premium_decay_last_error_message")
        .eq("id", 1)
        .single();

      if (data) {
        const row = data as BotSettingsRow;
        setLastHeartbeatAt(row.last_heartbeat_at);
        setPremiumDecayLastSampleAt(row.premium_decay_last_sample_at);
        setPremiumDecayLastErrorAt(row.premium_decay_last_error_at);
        setPremiumDecayLastErrorMessage(row.premium_decay_last_error_message);
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
          setPremiumDecayLastSampleAt(row.premium_decay_last_sample_at);
          setPremiumDecayLastErrorAt(row.premium_decay_last_error_at);
          setPremiumDecayLastErrorMessage(row.premium_decay_last_error_message);
          setNow(new Date());
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.12),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] text-slate-900">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 rounded-[1.5rem] border border-white/60 bg-white/70 px-6 py-5 shadow-[0_20px_60px_-35px_rgba(15,23,42,0.5)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Indian Market Scanner</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Premium decay control room</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Live CE/PE decay streamed from Supabase and rendered as a mirrored intraday area chart for options monitoring.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div
              className={`rounded-2xl border px-4 py-3 shadow-sm ${
                status.label === "STANDBY"
                  ? "border-slate-200 bg-slate-50"
                  : status.isAlive ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
              }`}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Bot heartbeat</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                <span className={status.label === "STANDBY" ? "text-slate-700" : status.isAlive ? "text-emerald-700" : "text-rose-700"}>
                  {status.label}
                </span>
              </p>
              <p className="text-sm text-slate-600">Last update: {status.message}</p>
            </div>
            <div
              className={`rounded-2xl border px-4 py-3 shadow-sm ${
                collectorStatus.label === "ACTIVE"
                  ? "border-emerald-200 bg-emerald-50"
                  : collectorStatus.label === "STANDBY"
                    ? "border-slate-200 bg-slate-50"
                    : "border-rose-200 bg-rose-50"
              }`}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Options collector</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                <span className={
                  collectorStatus.label === "ACTIVE"
                    ? "text-emerald-700"
                    : collectorStatus.label === "STANDBY" ? "text-slate-700" : "text-rose-700"
                }>
                  {collectorStatus.label}
                </span>
              </p>
              <p className="max-w-64 truncate text-sm text-slate-600" title={collectorStatus.message}>
                Last update: {collectorStatus.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const supabase = getBrowserSupabaseClient();
                void supabase.auth.signOut().then(() => {
                  window.location.href = "/login";
                });
              }}
              className="self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 sm:self-center"
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="flex flex-wrap gap-2 rounded-2xl border border-white/60 bg-white/70 p-2 shadow-sm backdrop-blur">
          <button
            type="button"
            aria-pressed={dashboardMode === "live"}
            onClick={() => setDashboardMode("live")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              dashboardMode === "live" ? "bg-slate-950 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-950"
            }`}
          >
            Live
          </button>
          <button
            type="button"
            aria-pressed={dashboardMode === "historical"}
            onClick={() => setDashboardMode("historical")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              dashboardMode === "historical" ? "bg-slate-950 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-950"
            }`}
          >
            Historical
          </button>
        </div>

        {dashboardMode === "historical" ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/60 bg-white/70 px-4 py-3 shadow-sm backdrop-blur">
            <label htmlFor="historical-session" className="text-sm font-semibold text-slate-700">Session date</label>
            <select
              id="historical-session"
              value={selectedHistoricalSessionDate ?? ""}
              onChange={(event) => setSelectedHistoricalSessionDate(event.target.value || null)}
              disabled={historyLoading || historicalSessionDates.length === 0}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {historicalSessionDates.length === 0 ? <option value="">No completed sessions</option> : null}
              {historicalSessionDates.map((sessionDate) => (
                <option key={sessionDate} value={sessionDate}>{formatSessionDate(sessionDate)}</option>
              ))}
            </select>
            {historyLoading ? <span className="text-sm text-slate-500">Loading sessions...</span> : null}
            {historyError ? <span className="text-sm text-amber-800">Could not load history: {historyError}</span> : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 rounded-2xl border border-white/60 bg-white/70 p-2 shadow-sm backdrop-blur">
          <button
            type="button"
            aria-pressed={chartMode === "atm"}
            onClick={() => setChartMode("atm")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              chartMode === "atm" ? "bg-slate-950 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-950"
            }`}
          >
            ATM premium decay
          </button>
          <button
            type="button"
            aria-pressed={chartMode === "band-average"}
            onClick={() => setChartMode("band-average")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              chartMode === "band-average" ? "bg-slate-950 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-950"
            }`}
          >
            Band average
          </button>
        </div>

        <div>
          {selectedSessionDate && chartVisibility.showAtm ? (
            <PremiumDecayChart
              key={`${dashboardMode}-${selectedSessionDate}-atm`}
              seriesKey="NIFTY-ATM-WEEKLY"
              sessionDate={selectedSessionDate}
              live={dashboardMode === "live"}
              title={dashboardMode === "live" ? "NIFTY premium decay" : `NIFTY premium decay - ${formatSessionDate(selectedSessionDate)}`}
              subtitle={dashboardMode === "live"
                ? "Signed CE and PE premium movement from the session baseline, streamed live from Supabase."
                : "Completed intraday CE and PE premium movement from the selected historical session."}
            />
          ) : null}
          {selectedSessionDate && chartVisibility.showBandAverage ? (
            <BandAverageChart
              key={`${dashboardMode}-${selectedSessionDate}-band`}
              sessionDate={selectedSessionDate}
              live={dashboardMode === "live"}
            />
          ) : null}
          {dashboardMode === "historical" && !historyLoading && !historyError && !selectedHistoricalSessionDate ? (
            <section className="rounded-[1.5rem] border border-dashed border-slate-200 bg-white/75 px-6 py-16 text-center shadow-sm backdrop-blur">
              <p className="text-sm font-semibold text-slate-700">No completed historical sessions yet</p>
              <p className="mt-2 text-sm text-slate-500">Today&apos;s graph will appear here after the 00:00 IST rollover.</p>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
