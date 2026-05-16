"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  Check,
  Clock3,
  Gauge,
  Receipt,
  ShieldAlert,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  WalletCards,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertFeedItem, ShadowTradePosition } from "@/lib/types";
import type { ThemeClasses } from "@/lib/theme";

const numberFormat = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const currencyFormat = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const percentFormat = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const FRESH_MS = 30_000;
const AGING_MS = 120_000;

type RrQuality = "good" | "marginal" | "poor";

function classifyRr(rr: number | null): RrQuality | null {
  if (rr === null || !Number.isFinite(rr) || rr <= 0) {
    return null;
  }
  if (rr >= 2) return "good";
  if (rr >= 1) return "marginal";
  return "poor";
}

type Freshness = "fresh" | "aging" | "stale";

function classifyFreshness(detectedAt: string): Freshness {
  const parsed = new Date(detectedAt).getTime();
  if (!Number.isFinite(parsed)) {
    return "stale";
  }
  const age = Date.now() - parsed;
  if (age <= FRESH_MS) return "fresh";
  if (age <= AGING_MS) return "aging";
  return "stale";
}

type TradePlan = {
  bearish: boolean;
  entry: number;
  vwap: number | null;
  stopLoss: number;
  profitMargin: number | null;
  riskMargin: number;
  rr: number | null;
  quality: RrQuality | null;
};

function computeTradePlan(alert: AlertFeedItem): TradePlan {
  const bearish = alert.direction === "bearish";
  const entry = alert.current_price;
  const vwap = alert.vwap;
  const stopLoss = bearish
    ? alert.trigger_price * 1.0015
    : alert.trigger_price * 0.9985;
  const profitMargin =
    vwap === null ? null : bearish ? entry - vwap : vwap - entry;
  const riskMargin = bearish ? stopLoss - entry : entry - stopLoss;
  const rr =
    profitMargin !== null && riskMargin > 0 ? profitMargin / riskMargin : null;
  const quality = classifyRr(rr);
  return { bearish, entry, vwap, stopLoss, profitMargin, riskMargin, rr, quality };
}

function tradeSafetyReason(
  plan: TradePlan,
  freshness: Freshness,
): string | null {
  if (plan.vwap === null) return "No VWAP target — cannot define exit";
  if (freshness === "stale") return "Data is stale — refresh before trading";
  if (plan.quality === "poor") return "Risk:Reward below 1 — unfavorable";
  if (plan.riskMargin <= 0) return "Invalid stop — entry past trigger buffer";
  return null;
}

export function MarketSniperDashboard({
  supabase,
  userId,
  ui,
}: {
  supabase: SupabaseClient;
  userId: string;
  ui: ThemeClasses;
}) {
  const [alerts, setAlerts] = useState<AlertFeedItem[]>([]);
  const [trades, setTrades] = useState<ShadowTradePosition[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [submittingAlertIds, setSubmittingAlertIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openedAlertIds, setOpenedAlertIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Ref-based in-flight gate: state setters batch, so two clicks in the
  // same tick both pass the Set check and double-submit the RPC.
  const inFlightAlertIds = useRef<Set<string>>(new Set());

  const refreshAlerts = useCallback(async () => {
    const { data, error } = await supabase
      .from("alert_feed")
      .select("*")
      .eq("status", "active")
      .order("detected_at", { ascending: false })
      .limit(25);

    if (error) {
      setMessage(error.message);
      return;
    }

    setAlerts((data ?? []) as AlertFeedItem[]);
  }, [supabase]);

  const refreshTrades = useCallback(async () => {
    const { data, error } = await supabase
      .from("shadow_trade_positions")
      .select("*")
      .eq("user_id", userId)
      .order("opened_at", { ascending: false });

    if (error) {
      setMessage(error.message);
      return;
    }

    const positions = (data ?? []) as ShadowTradePosition[];
    setTrades(positions);
    setOpenedAlertIds(
      new Set(
        positions
          .filter((trade) => trade.alert_id)
          .map((trade) => trade.alert_id as string),
      ),
    );
  }, [supabase, userId]);

  useEffect(() => {
    queueMicrotask(() => {
      void refreshAlerts();
      void refreshTrades();
    });

    const alertChannel = supabase
      .channel("market-sniper-alert-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "alerts" },
        () => void refreshAlerts(),
      )
      .subscribe();

    const tradeChannel = supabase
      .channel(`market-sniper-shadow-trades-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shadow_trades",
          filter: `user_id=eq.${userId}`,
        },
        () => void refreshTrades(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(alertChannel);
      void supabase.removeChannel(tradeChannel);
    };
  }, [refreshAlerts, refreshTrades, supabase, userId]);

  const openTrades = trades.filter((trade) => trade.status === "open");
  const totalPnl = openTrades.reduce((sum, trade) => sum + trade.unrealized_pnl, 0);
  const averageConviction =
    alerts.length > 0
      ? Math.round(
          alerts.reduce((sum, alert) => sum + alert.conviction_score, 0) /
            alerts.length,
        )
      : 0;

  async function paperTrade(alert: AlertFeedItem, quantity: number) {
    if (inFlightAlertIds.current.has(alert.id) || openedAlertIds.has(alert.id)) {
      return;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      setMessage("Quantity must be a positive whole number.");
      return;
    }

    inFlightAlertIds.current.add(alert.id);
    setSubmittingAlertIds((current) => new Set(current).add(alert.id));

    try {
      const { error } = await supabase.rpc("open_shadow_trade", {
        p_alert_id: alert.id,
        p_quantity: quantity,
      });

      if (error) {
        setMessage(`Shadow trade failed: ${error.message}`);
        return;
      }

      setOpenedAlertIds((current) => new Set(current).add(alert.id));
      setMessage(`${alert.symbol} shadow trade opened (qty ${quantity}).`);
      await refreshTrades();
    } catch (error) {
      setMessage(
        `Shadow trade failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    } finally {
      inFlightAlertIds.current.delete(alert.id);
      setSubmittingAlertIds((current) => {
        const next = new Set(current);
        next.delete(alert.id);
        return next;
      });
    }
  }

  async function closeTrade(trade: ShadowTradePosition) {
    const { error } = await supabase.rpc("close_shadow_trade", {
      p_trade_id: trade.id,
    });

    if (error) {
      setMessage(`Close failed: ${error.message}`);
      return;
    }

    await refreshTrades();
  }

  return (
    <>
      <div className="mx-auto grid max-w-7xl gap-3 px-4 pb-2 pt-1 sm:px-6 md:grid-cols-3 lg:px-8">
        <Metric ui={ui} label="Active alerts" value={alerts.length.toString()} />
        <Metric ui={ui} label="Avg conviction" value={`${averageConviction}%`} />
        <Metric
          ui={ui}
          label="Open P&L"
          value={currencyFormat.format(totalPnl)}
          tone={totalPnl >= 0 ? "positive" : "negative"}
        />
      </div>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:px-8">
        <section className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BellRing className={`size-5 ${ui.accentText}`} />
              <h2 className="text-lg font-semibold">Live Alert Feed</h2>
            </div>
            <span className={`font-mono text-xs uppercase tracking-[0.2em] ${ui.mutedText}`}>
              Realtime
            </span>
          </div>
          <div className="space-y-4">
            {alerts.length === 0 ? (
              <EmptyState
                ui={ui}
                title="No live alerts"
                detail="No active Supabase alerts are available right now."
              />
            ) : null}
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                isOpened={openedAlertIds.has(alert.id)}
                isSubmitting={submittingAlertIds.has(alert.id)}
                onPaperTrade={paperTrade}
                ui={ui}
              />
            ))}
          </div>
        </section>

        <aside className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <WalletCards className={`size-5 ${ui.accentText}`} />
              <h2 className="text-lg font-semibold">Shadow Portfolio</h2>
            </div>
            <span className={`text-sm ${ui.mutedText}`}>{openTrades.length} open</span>
          </div>

          <PerformanceSummary trades={trades} ui={ui} />

          <div className="mt-3 space-y-3">
            {trades.length === 0 ? (
              <EmptyState
                ui={ui}
                title="No shadow trades"
                detail="Open a trade from a live alert."
              />
            ) : (
              trades.map((trade) => (
                <TradeCard key={trade.id} trade={trade} onClose={closeTrade} ui={ui} />
              ))
            )}
          </div>
        </aside>
      </div>

      {message ? (
        <button
          className={`fixed bottom-4 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border px-4 py-3 text-left text-sm shadow-2xl ${ui.toast}`}
          onClick={() => setMessage(null)}
        >
          <span>{message}</span>
          <X className={`size-4 ${ui.mutedText}`} />
        </button>
      ) : null}
    </>
  );
}

function AlertCard({
  alert,
  isOpened,
  isSubmitting,
  onPaperTrade,
  ui,
}: {
  alert: AlertFeedItem;
  isOpened: boolean;
  isSubmitting: boolean;
  onPaperTrade: (alert: AlertFeedItem, quantity: number) => void;
  ui: ThemeClasses;
}) {
  const bearish = alert.direction === "bearish";
  const [quantity, setQuantity] = useState(1);
  const freshness = classifyFreshness(alert.detected_at);
  const freshnessClass =
    freshness === "fresh"
      ? ui.freshnessFresh
      : freshness === "aging"
        ? ui.freshnessAging
        : ui.freshnessStale;
  const plan = computeTradePlan(alert);
  const safetyReason = tradeSafetyReason(plan, freshness);
  const blocked = safetyReason !== null;

  return (
    <article className={`rounded-lg border p-4 shadow-2xl ${ui.card}`}>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded border px-2 py-1 font-mono text-xs ${ui.symbolPill}`}>
              {alert.exchange}:{alert.symbol}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${
                bearish ? ui.bearishPill : ui.bullishPill
              }`}
            >
              {bearish ? (
                <ArrowDownRight className="size-3.5" />
              ) : (
                <ArrowUpRight className="size-3.5" />
              )}
              {alert.direction.toUpperCase()}
            </span>
            <span className={`inline-flex items-center gap-1 text-xs ${freshnessClass}`}>
              <Clock3 className="size-3.5" />
              {relativeTime(alert.detected_at)}
              {freshness === "stale" ? " · stale" : null}
            </span>
          </div>
          <h3 className={`mt-3 text-xl font-semibold ${ui.heading}`}>{alert.title}</h3>
          <p className={`mt-2 max-w-3xl text-sm leading-6 ${ui.secondaryText}`}>
            {alert.thesis}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <Conviction score={alert.conviction_score} ui={ui} />
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DataTile ui={ui} label="Trigger" value={currencyFormat.format(alert.trigger_price)} />
        <DataTile ui={ui} label="Current" value={currencyFormat.format(alert.current_price)} />
        <DataTile ui={ui} label="Swept level" value={alert.swept_level_name} />
        <DataTile ui={ui} label="Volume" value={`${alert.volume_multiplier}x`} />
      </div>

      {alert.score_factors.length > 0 ? (
        <div
          className={`mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs ${ui.secondaryText}`}
        >
          {alert.score_factors.map((factor) => (
            <span
              key={`${alert.id}-${factor.name}`}
              className="inline-flex items-center gap-1.5"
            >
              <Check className={`size-3.5 ${ui.accentText}`} />
              <span className={ui.heading}>{factor.name}</span>
              <span className={ui.mutedText}>· {factor.state}</span>
            </span>
          ))}
        </div>
      ) : null}

      <ExecutionPlan
        plan={plan}
        quantity={quantity}
        onQuantityChange={setQuantity}
        ui={ui}
      />

      <button
        className={`mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold transition ${
          isOpened
            ? ui.successButton
            : blocked
              ? ui.outlineButton + " cursor-not-allowed opacity-70"
              : ui.paperTradeButton
        }`}
        disabled={isSubmitting || isOpened || blocked}
        onClick={() => onPaperTrade(alert, quantity)}
        aria-label={
          blocked
            ? `Paper trade disabled: ${safetyReason}`
            : `Paper trade ${alert.symbol} quantity ${quantity}`
        }
        title={safetyReason ?? undefined}
      >
        {blocked ? <ShieldAlert className="size-4" /> : <Target className="size-4" />}
        {isOpened
          ? "Trade Open"
          : isSubmitting
            ? "Opening..."
            : blocked
              ? "Trade Blocked"
              : `Paper Trade (qty ${quantity})`}
      </button>

      {blocked && !isOpened ? (
        <p
          className={`mt-2 text-center text-xs ${ui.negativeText}`}
          role="status"
        >
          {safetyReason}
        </p>
      ) : null}
    </article>
  );
}

function ExecutionPlan({
  plan,
  quantity,
  onQuantityChange,
  ui,
}: {
  plan: TradePlan;
  quantity: number;
  onQuantityChange: (next: number) => void;
  ui: ThemeClasses;
}) {
  const { bearish, entry, vwap, stopLoss, profitMargin, riskMargin, rr: rrRatio, quality: rrQuality } = plan;

  const tpPercent =
    vwap !== null && entry > 0 ? ((bearish ? entry - vwap : vwap - entry) / entry) * 100 : null;
  const slPercent = entry > 0 ? ((bearish ? stopLoss - entry : entry - stopLoss) / entry) * 100 : null;

  const totalRisk = riskMargin > 0 ? riskMargin * quantity : null;
  const totalReward = profitMargin !== null && profitMargin > 0 ? profitMargin * quantity : null;

  const actionLabel = bearish ? "SHORT ENTRY" : "LONG ENTRY";
  const actionPill = bearish ? ui.shortPill : ui.longPill;
  const ActionIcon = bearish ? TrendingDown : TrendingUp;

  const qualityChip =
    rrQuality === "good"
      ? { className: ui.qualityGood, label: "GOOD" }
      : rrQuality === "marginal"
        ? { className: ui.qualityMarginal, label: "MARGINAL" }
        : rrQuality === "poor"
          ? { className: ui.qualityPoor, label: "POOR" }
          : null;

  return (
    <section className={`mt-5 rounded-md border-2 ${ui.executionPlan}`}>
      <header
        className={`flex items-center justify-between border-b px-4 py-2 ${ui.executionPlanHeader}`}
      >
        <div className="flex items-center gap-2">
          <Receipt className="size-4" />
          <span className="font-mono text-xs uppercase tracking-[0.22em]">
            Trade Execution Plan
          </span>
        </div>
        <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${ui.mutedText}`}>
          Order Ticket
        </span>
      </header>

      <div className="grid gap-3 px-4 py-4 md:grid-cols-3">
        <div className={`rounded-md border px-3 py-3 ${ui.subtlePanel}`}>
          <div className={`text-[10px] uppercase tracking-[0.18em] ${ui.mutedText}`}>
            Action
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-bold tracking-wider ${actionPill}`}
            >
              <ActionIcon className="size-3.5" />
              {actionLabel}
            </span>
          </div>
          <div className={`mt-2 font-mono text-lg font-semibold ${ui.heading}`}>
            @ {currencyFormat.format(entry)}
          </div>
        </div>

        <div className={`rounded-md border px-3 py-3 ${ui.subtlePanel}`}>
          <div className="flex items-center justify-between">
            <div className={`text-[10px] uppercase tracking-[0.18em] ${ui.mutedText}`}>
              Take Profit
            </div>
            <Target className={`size-3.5 ${ui.positiveText}`} />
          </div>
          {vwap === null ? (
            <>
              <div className={`mt-2 font-mono text-lg font-semibold ${ui.mutedText}`}>
                VWAP n/a
              </div>
              <div className={`mt-1 text-xs ${ui.mutedText}`}>Awaiting fresh VWAP</div>
            </>
          ) : (
            <>
              <div className={`mt-2 font-mono text-lg font-semibold ${ui.positiveText}`}>
                {currencyFormat.format(vwap)}
              </div>
              <div className={`mt-1 flex items-center justify-between text-xs ${ui.positiveText}`}>
                <span>
                  {profitMargin !== null && profitMargin >= 0 ? "+" : ""}
                  {profitMargin !== null ? numberFormat.format(profitMargin) : "—"} pts
                </span>
                <span className="font-mono">
                  {tpPercent !== null ? `${tpPercent >= 0 ? "+" : ""}${percentFormat.format(tpPercent)}%` : "—"}
                </span>
              </div>
            </>
          )}
        </div>

        <div className={`rounded-md border px-3 py-3 ${ui.subtlePanel}`}>
          <div className="flex items-center justify-between">
            <div className={`text-[10px] uppercase tracking-[0.18em] ${ui.mutedText}`}>
              Stop Loss
            </div>
            <ShieldAlert className={`size-3.5 ${ui.negativeText}`} />
          </div>
          <div className={`mt-2 font-mono text-lg font-semibold ${ui.negativeText}`}>
            {currencyFormat.format(stopLoss)}
          </div>
          <div className={`mt-1 flex items-center justify-between text-xs ${ui.negativeText}`}>
            <span>−{numberFormat.format(Math.abs(riskMargin))} pts</span>
            <span className="font-mono">
              {slPercent !== null ? `−${percentFormat.format(Math.abs(slPercent))}%` : "—"}
            </span>
          </div>
          <div className={`mt-1 text-[10px] uppercase tracking-[0.14em] ${ui.mutedText}`}>
            0.15% trigger buffer
          </div>
        </div>
      </div>

      <div className={`grid gap-3 border-t px-4 py-3 sm:grid-cols-[auto_1fr_1fr] ${ui.executionPlanHeader}`}>
        <label className="flex items-center gap-2">
          <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${ui.mutedText}`}>
            Qty
          </span>
          <input
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              onQuantityChange(Number.isFinite(next) && next > 0 ? next : 1);
            }}
            className={`h-8 w-20 rounded-md border px-2 font-mono text-sm outline-none focus:ring-2 ${ui.qtyInput}`}
          />
        </label>
        <div className="flex flex-col gap-0.5">
          <span className={`font-mono text-[10px] uppercase tracking-[0.18em] ${ui.mutedText}`}>
            Total Risk
          </span>
          <span className={`font-mono text-sm font-semibold ${ui.negativeText}`}>
            {totalRisk !== null ? `−${currencyFormat.format(totalRisk)}` : "—"}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={`font-mono text-[10px] uppercase tracking-[0.18em] ${ui.mutedText}`}>
            Total Reward
          </span>
          <span className={`font-mono text-sm font-semibold ${ui.positiveText}`}>
            {totalReward !== null ? `+${currencyFormat.format(totalReward)}` : "—"}
          </span>
        </div>
      </div>

      <footer
        className={`flex items-center justify-between border-t px-4 py-2 ${ui.executionPlanHeader}`}
      >
        <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${ui.mutedText}`}>
          Risk : Reward
        </span>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-sm font-semibold ${ui.accentText}`}>
            {rrRatio !== null && Number.isFinite(rrRatio)
              ? `${numberFormat.format(rrRatio)} : 1`
              : "—"}
          </span>
          {qualityChip ? (
            <span
              className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold tracking-[0.18em] ${qualityChip.className}`}
            >
              {qualityChip.label}
            </span>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

function Conviction({ score, ui }: { score: number; ui: ThemeClasses }) {
  return (
    <div className={`grid size-14 place-items-center rounded-lg border ${ui.convictionBox}`}>
      <div className="text-center">
        <div className={`font-mono text-base font-semibold ${ui.accentText}`}>{score}%</div>
        <div
          className={`mt-0.5 flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] ${ui.mutedText}`}
        >
          <Gauge className="size-2.5" />
          Score
        </div>
      </div>
    </div>
  );
}

function PerformanceSummary({
  trades,
  ui,
}: {
  trades: ShadowTradePosition[];
  ui: ThemeClasses;
}) {
  const closed = trades.filter((trade) => trade.status === "closed");
  const totalClosed = closed.length;
  const wins = closed.filter((trade) => trade.unrealized_pnl > 0).length;
  const losses = closed.filter((trade) => trade.unrealized_pnl < 0).length;
  const realized = closed.reduce((sum, trade) => sum + trade.unrealized_pnl, 0);
  const winRate = totalClosed > 0 ? Math.round((wins / totalClosed) * 100) : null;

  return (
    <div className={`rounded-lg border p-3 ${ui.card}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Trophy className={`size-3.5 ${ui.accentText}`} />
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.22em] ${ui.mutedText}`}
          >
            Performance
          </span>
        </div>
        <span className={`text-[11px] ${ui.mutedText}`}>
          {totalClosed > 0 ? `${totalClosed} closed` : "no closed trades yet"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <PerfCell
          ui={ui}
          label="Realized"
          value={totalClosed > 0 ? currencyFormat.format(realized) : "—"}
          tone={realized >= 0 ? "positive" : "negative"}
        />
        <PerfCell
          ui={ui}
          label="Win rate"
          value={winRate !== null ? `${winRate}%` : "—"}
          tone={
            winRate === null
              ? "neutral"
              : winRate >= 50
                ? "positive"
                : "negative"
          }
        />
        <PerfCell
          ui={ui}
          label="W / L"
          value={totalClosed > 0 ? `${wins} / ${losses}` : "—"}
          tone="neutral"
        />
      </div>
    </div>
  );
}

function PerfCell({
  ui,
  label,
  value,
  tone,
}: {
  ui: ThemeClasses;
  label: string;
  value: string;
  tone: "neutral" | "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? ui.positiveText
      : tone === "negative"
        ? ui.negativeText
        : ui.heading;
  return (
    <div className={`rounded-md border px-2.5 py-2 ${ui.subtlePanel}`}>
      <div
        className={`text-[10px] uppercase tracking-[0.14em] ${ui.mutedText}`}
      >
        {label}
      </div>
      <div className={`mt-1 truncate font-mono text-sm font-semibold ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function TradeCard({
  trade,
  onClose,
  ui,
}: {
  trade: ShadowTradePosition;
  onClose: (trade: ShadowTradePosition) => void;
  ui: ThemeClasses;
}) {
  const positive = trade.unrealized_pnl >= 0;
  const [confirming, setConfirming] = useState(false);

  // Auto-reset the confirm state if user walks away.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  return (
    <article className={`rounded-lg border p-4 ${ui.card}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`font-mono text-sm ${ui.accentText}`}>
            {trade.exchange}:{trade.symbol}
          </div>
          <div className={`mt-1 text-sm ${ui.secondaryText}`}>
            {trade.side.toUpperCase()} x {trade.quantity}
          </div>
        </div>
        <div className={`text-right ${positive ? ui.positiveText : ui.negativeText}`}>
          <div className="font-mono text-lg font-semibold">
            {currencyFormat.format(trade.unrealized_pnl)}
          </div>
          <div className="text-xs">{numberFormat.format(trade.pnl_percent)}%</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <DataTile ui={ui} label="Entry" value={currencyFormat.format(trade.entry_price)} />
        <DataTile ui={ui} label="Mark" value={currencyFormat.format(trade.current_price)} />
      </div>
      {trade.status === "open" ? (
        <button
          className={`mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border text-sm font-medium transition ${
            confirming ? ui.qualityPoor : ui.outlineButton
          }`}
          onClick={() => {
            if (confirming) {
              setConfirming(false);
              onClose(trade);
            } else {
              setConfirming(true);
            }
          }}
          aria-label={
            confirming
              ? `Confirm close ${trade.symbol}, locks in P&L ${currencyFormat.format(trade.unrealized_pnl)}`
              : `Close shadow trade ${trade.symbol}`
          }
        >
          <X className="size-4" />
          {confirming
            ? `Confirm — lock in ${currencyFormat.format(trade.unrealized_pnl)}`
            : "Close Shadow Trade"}
        </button>
      ) : (
        <div className={`mt-4 rounded-md px-3 py-2 text-center text-sm ${ui.subtlePanel}`}>
          Closed
        </div>
      )}
    </article>
  );
}

function Metric({
  ui,
  label,
  value,
  tone = "neutral",
}: {
  ui: ThemeClasses;
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? ui.positiveText
      : tone === "negative"
        ? ui.negativeText
        : ui.heading;

  return (
    <div className={`rounded-lg border px-4 py-3 ${ui.card}`}>
      <div className={`text-xs uppercase tracking-[0.18em] ${ui.mutedText}`}>{label}</div>
      <div className={`mt-2 font-mono text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function DataTile({ ui, label, value }: { ui: ThemeClasses; label: string; value: string }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${ui.subtlePanel}`}>
      <div className={`text-xs uppercase tracking-[0.14em] ${ui.mutedText}`}>{label}</div>
      <div className={`mt-1 truncate font-mono text-sm ${ui.heading}`}>{value}</div>
    </div>
  );
}

function EmptyState({
  ui,
  title,
  detail,
}: {
  ui: ThemeClasses;
  title: string;
  detail: string;
}) {
  return (
    <div className={`rounded-lg border p-5 ${ui.card}`}>
      <div className={`text-sm font-semibold ${ui.heading}`}>{title}</div>
      <div className={`mt-1 text-sm ${ui.secondaryText}`}>{detail}</div>
    </div>
  );
}

function relativeTime(timestamp: string) {
  const parsed = new Date(timestamp).getTime();

  if (!Number.isFinite(parsed)) {
    return "—";
  }

  const diff = Date.now() - parsed;

  if (diff < 60000) {
    return "just now";
  }

  const minutes = Math.round(diff / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
