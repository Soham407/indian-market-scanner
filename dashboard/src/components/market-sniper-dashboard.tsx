"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  Clock3,
  Crosshair,
  Gauge,
  LogIn,
  ShieldCheck,
  Target,
  WalletCards,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sampleAlerts } from "@/lib/sample-data";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { AlertFeedItem, ShadowTradePosition } from "@/lib/types";

type AuthState = "checking" | "signed-in" | "signed-out" | "unconfigured";

const numberFormat = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

export function MarketSniperDashboard() {
  const configured = isSupabaseConfigured();
  const [authState, setAuthState] = useState<AuthState>(
    configured ? "checking" : "unconfigured",
  );
  const [userId, setUserId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertFeedItem[]>(
    configured ? [] : sampleAlerts,
  );
  const [trades, setTrades] = useState<ShadowTradePosition[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAlertId, setPendingAlertId] = useState<string | null>(null);
  const supabase = useMemo(() => createBrowserClient(), []);

  const refreshAlerts = useCallback(async () => {
    if (!supabase) {
      return;
    }

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
    if (!supabase || !userId) {
      return;
    }

    const { data, error } = await supabase
      .from("shadow_trade_positions")
      .select("*")
      .eq("user_id", userId)
      .order("opened_at", { ascending: false });

    if (error) {
      setMessage(error.message);
      return;
    }

    setTrades((data ?? []) as ShadowTradePosition[]);
  }, [supabase, userId]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let mounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) {
        return;
      }
      const user = data.user;
      setUserId(user?.id ?? null);
      setAuthState(user ? "signed-in" : "signed-out");
      if (!user) {
        setTrades([]);
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUserId(session?.user.id ?? null);
        setAuthState(session?.user ? "signed-in" : "signed-out");
        if (!session?.user) {
          setTrades([]);
        }
      },
    );

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [supabase]);

  const openTrades = trades.filter((trade) => trade.status === "open");
  const totalPnl = openTrades.reduce((sum, trade) => sum + trade.unrealized_pnl, 0);
  const averageConviction =
    alerts.length > 0
      ? Math.round(
          alerts.reduce((sum, alert) => sum + alert.conviction_score, 0) /
            alerts.length,
        )
      : 0;

  useEffect(() => {
    if (!supabase || authState !== "signed-in") {
      return;
    }

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
      .channel("market-sniper-shadow-trades")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shadow_trades" },
        () => void refreshTrades(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(alertChannel);
      void supabase.removeChannel(tradeChannel);
    };
  }, [authState, refreshAlerts, refreshTrades, supabase]);

  async function signIn() {
    if (!supabase) {
      setAuthState("unconfigured");
      setMessage("Supabase env vars are not configured.");
      return;
    }

    const email = window.prompt("Email for magic link");

    if (!email) {
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    setMessage(error ? error.message : "Magic link sent.");
  }

  async function paperTrade(alert: AlertFeedItem) {
    if (!supabase || !userId) {
      setMessage("Sign in required before opening a shadow trade.");
      await signIn();
      return;
    }

    setPendingAlertId(alert.id);

    const { error } = await supabase.rpc("open_shadow_trade", {
      p_alert_id: alert.id,
      p_quantity: 1,
    });

    setPendingAlertId(null);

    if (error) {
      setMessage(`Shadow trade failed: ${error.message}`);
      return;
    }

    setMessage(`${alert.symbol} shadow trade opened.`);
    await refreshTrades();
  }

  async function closeTrade(trade: ShadowTradePosition) {
    if (!supabase || !userId) {
      setMessage("Sign in required before closing a shadow trade.");
      await signIn();
      return;
    }

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
    <main className="min-h-screen bg-[#070907] text-stone-100">
      <div className="border-b border-lime-300/10 bg-[#0b0f0b]/95">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-3 text-lime-300">
                <Crosshair className="size-6" />
                <span className="font-mono text-xs uppercase tracking-[0.28em]">
                  Market Sniper
                </span>
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-normal text-stone-50 sm:text-4xl">
                Institutional liquidity trap monitor
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill
                icon={<ShieldCheck className="size-4" />}
                label={authLabel(authState)}
              />
              {authState !== "signed-in" ? (
                <button
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-lime-300 px-4 text-sm font-semibold text-[#10140f] transition hover:bg-lime-200"
                  onClick={signIn}
                >
                  <LogIn className="size-4" />
                  Sign in
                </button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Metric label="Active alerts" value={alerts.length.toString()} />
            <Metric label="Avg conviction" value={`${averageConviction}%`} />
            <Metric
              label="Open P&L"
              value={`Rs. ${numberFormat.format(totalPnl)}`}
              tone={totalPnl >= 0 ? "positive" : "negative"}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:px-8">
        <section className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BellRing className="size-5 text-lime-300" />
              <h2 className="text-lg font-semibold">Live Alert Feed</h2>
            </div>
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-stone-500">
              Realtime
            </span>
          </div>
          <div className="space-y-4">
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                authState={authState}
                isPending={pendingAlertId === alert.id}
                onPaperTrade={paperTrade}
              />
            ))}
          </div>
        </section>

        <aside className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <WalletCards className="size-5 text-lime-300" />
              <h2 className="text-lg font-semibold">Shadow Portfolio</h2>
            </div>
            <span className="text-sm text-stone-500">{openTrades.length} open</span>
          </div>
          <div className="space-y-3">
            {trades.length === 0 ? (
              <div className="rounded-lg border border-stone-800 bg-[#0d120d] p-5 text-sm text-stone-400">
                No shadow trades yet.
              </div>
            ) : (
              trades.map((trade) => (
                <TradeCard key={trade.id} trade={trade} onClose={closeTrade} />
              ))
            )}
          </div>
        </aside>
      </div>

      {message ? (
        <button
          className="fixed bottom-4 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-stone-700 bg-[#101510] px-4 py-3 text-left text-sm text-stone-200 shadow-2xl"
          onClick={() => setMessage(null)}
        >
          <span>{message}</span>
          <X className="size-4 text-stone-500" />
        </button>
      ) : null}
    </main>
  );
}

function AlertCard({
  alert,
  authState,
  isPending,
  onPaperTrade,
}: {
  alert: AlertFeedItem;
  authState: AuthState;
  isPending: boolean;
  onPaperTrade: (alert: AlertFeedItem) => void;
}) {
  const bearish = alert.direction === "bearish";
  const requiresAuth = authState !== "signed-in";

  return (
    <article className="rounded-lg border border-stone-800 bg-[#0d120d] p-4 shadow-2xl shadow-black/20">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-lime-300/30 px-2 py-1 font-mono text-xs text-lime-200">
              {alert.exchange}:{alert.symbol}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${
                bearish
                  ? "bg-red-400/10 text-red-300"
                  : "bg-emerald-400/10 text-emerald-300"
              }`}
            >
              {bearish ? (
                <ArrowDownRight className="size-3.5" />
              ) : (
                <ArrowUpRight className="size-3.5" />
              )}
              {alert.direction.toUpperCase()}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-stone-500">
              <Clock3 className="size-3.5" />
              {relativeTime(alert.detected_at)}
            </span>
          </div>
          <h3 className="mt-3 text-xl font-semibold text-stone-50">{alert.title}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
            {alert.thesis}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <Conviction score={alert.conviction_score} />
          <button
            className={`inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold transition ${
              requiresAuth
                ? "border border-stone-700 bg-stone-900 text-stone-300 hover:border-lime-300/50 hover:text-lime-200"
                : "bg-stone-100 text-[#10140f] hover:bg-lime-200"
            }`}
            disabled={isPending || authState === "checking"}
            onClick={() => onPaperTrade(alert)}
          >
            {requiresAuth ? <LogIn className="size-4" /> : <Target className="size-4" />}
            {buttonLabel(authState, isPending)}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DataTile label="Trigger" value={`Rs. ${numberFormat.format(alert.trigger_price)}`} />
        <DataTile label="Current" value={`Rs. ${numberFormat.format(alert.current_price)}`} />
        <DataTile label="Swept level" value={alert.swept_level_name} />
        <DataTile label="Volume" value={`${alert.volume_multiplier}x`} />
      </div>

      <div className="mt-5 grid gap-2 md:grid-cols-2">
        {alert.score_factors.map((factor) => (
          <div
            key={`${alert.id}-${factor.name}`}
            className="flex items-center justify-between rounded-md border border-stone-800 bg-black/20 px-3 py-2"
          >
            <div>
              <div className="text-sm text-stone-200">{factor.name}</div>
              <div className="text-xs text-stone-500">{factor.state}</div>
            </div>
            <span className="font-mono text-sm text-lime-200">+{factor.score}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function Conviction({ score }: { score: number }) {
  return (
    <div className="grid size-20 place-items-center rounded-lg border border-lime-300/30 bg-lime-300/5">
      <div className="text-center">
        <div className="font-mono text-2xl font-semibold text-lime-200">{score}%</div>
        <div className="mt-1 flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.16em] text-stone-500">
          <Gauge className="size-3" />
          Score
        </div>
      </div>
    </div>
  );
}

function TradeCard({
  trade,
  onClose,
}: {
  trade: ShadowTradePosition;
  onClose: (trade: ShadowTradePosition) => void;
}) {
  const positive = trade.unrealized_pnl >= 0;

  return (
    <article className="rounded-lg border border-stone-800 bg-[#0d120d] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-sm text-lime-200">
            {trade.exchange}:{trade.symbol}
          </div>
          <div className="mt-1 text-sm text-stone-400">
            {trade.side.toUpperCase()} x {trade.quantity}
          </div>
        </div>
        <div className={`text-right ${positive ? "text-emerald-300" : "text-red-300"}`}>
          <div className="font-mono text-lg font-semibold">
            Rs. {numberFormat.format(trade.unrealized_pnl)}
          </div>
          <div className="text-xs">{numberFormat.format(trade.pnl_percent)}%</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <DataTile label="Entry" value={`Rs. ${numberFormat.format(trade.entry_price)}`} />
        <DataTile label="Mark" value={`Rs. ${numberFormat.format(trade.current_price)}`} />
      </div>
      {trade.status === "open" ? (
        <button
          className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-stone-700 text-sm font-medium text-stone-200 transition hover:border-lime-300/50 hover:text-lime-200"
          onClick={() => onClose(trade)}
        >
          <X className="size-4" />
          Close Shadow Trade
        </button>
      ) : (
        <div className="mt-4 rounded-md bg-stone-900 px-3 py-2 text-center text-sm text-stone-500">
          Closed
        </div>
      )}
    </article>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-300"
      : tone === "negative"
        ? "text-red-300"
        : "text-stone-50";

  return (
    <div className="rounded-lg border border-stone-800 bg-[#0d120d] px-4 py-3">
      <div className="text-xs uppercase tracking-[0.18em] text-stone-500">{label}</div>
      <div className={`mt-2 font-mono text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function DataTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-stone-800 bg-black/20 px-3 py-2">
      <div className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</div>
      <div className="mt-1 truncate font-mono text-sm text-stone-100">{value}</div>
    </div>
  );
}

function StatusPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="inline-flex h-10 items-center gap-2 rounded-md border border-stone-700 px-3 text-sm text-stone-300">
      {icon}
      {label}
    </div>
  );
}

function authLabel(authState: AuthState) {
  if (authState === "signed-in") {
    return "RLS active";
  }

  if (authState === "unconfigured") {
    return "Supabase not configured";
  }

  if (authState === "checking") {
    return "Checking auth";
  }

  return "Sign in required";
}

function buttonLabel(authState: AuthState, isPending: boolean) {
  if (isPending) {
    return "Opening...";
  }

  if (authState === "checking") {
    return "Checking Auth";
  }

  if (authState !== "signed-in") {
    return "Sign In to Trade";
  }

  return "Paper Trade";
}

function relativeTime(timestamp: string) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  return `${Math.round(minutes / 60)}h ago`;
}
