"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  Clock3,
  Crosshair,
  Gauge,
  LogIn,
  Moon,
  ShieldCheck,
  Sun,
  Target,
  WalletCards,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { AlertFeedItem, ShadowTradePosition } from "@/lib/types";

type AuthState = "checking" | "signed-in" | "signed-out" | "unconfigured";
type Theme = "dark" | "light";

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
  const [theme, setTheme] = useState<Theme>("dark");
  const [alerts, setAlerts] = useState<AlertFeedItem[]>([]);
  const [trades, setTrades] = useState<ShadowTradePosition[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [submittingAlertIds, setSubmittingAlertIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openedAlertIds, setOpenedAlertIds] = useState<Set<string>>(
    () => new Set(),
  );
  const supabase = useMemo(() => createBrowserClient(), []);
  const ui = getThemeClasses(theme);

  useEffect(() => {
    queueMicrotask(() => {
      const storedTheme = window.localStorage.getItem("market-sniper-theme");

      if (storedTheme === "dark" || storedTheme === "light") {
        setTheme(storedTheme);
        return;
      }

      setTheme(
        window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark",
      );
    });
  }, []);

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem("market-sniper-theme", next);
      return next;
    });
  }

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
        setOpenedAlertIds(new Set());
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUserId(session?.user.id ?? null);
        setAuthState(session?.user ? "signed-in" : "signed-out");
        if (!session?.user) {
          setTrades([]);
          setOpenedAlertIds(new Set());
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
    if (submittingAlertIds.has(alert.id) || openedAlertIds.has(alert.id)) {
      return;
    }

    if (!supabase || !userId) {
      setMessage("Sign in required before opening a shadow trade.");
      await signIn();
      return;
    }

    setSubmittingAlertIds((current) => new Set(current).add(alert.id));

    try {
      const { error } = await supabase.rpc("open_shadow_trade", {
        p_alert_id: alert.id,
        p_quantity: 1,
      });

      if (error) {
        setMessage(`Shadow trade failed: ${error.message}`);
        return;
      }

      setOpenedAlertIds((current) => new Set(current).add(alert.id));
      setMessage(`${alert.symbol} shadow trade opened.`);
      await refreshTrades();
    } catch (error) {
      setMessage(
        `Shadow trade failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    } finally {
      setSubmittingAlertIds((current) => {
        const next = new Set(current);
        next.delete(alert.id);
        return next;
      });
    }
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
    <main className={`min-h-screen transition-colors ${ui.page}`}>
      <div className={`border-b ${ui.header}`}>
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className={`flex items-center gap-3 ${ui.accentText}`}>
                <Crosshair className="size-6" />
                <span className="font-mono text-xs uppercase tracking-[0.28em]">
                  Market Sniper
                </span>
              </div>
              <h1 className={`mt-3 text-3xl font-semibold tracking-normal sm:text-4xl ${ui.heading}`}>
                Institutional liquidity trap monitor
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm transition ${ui.outlineButton}`}
                onClick={toggleTheme}
              >
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                {theme === "dark" ? "Light" : "Dark"}
              </button>
              <StatusPill
                icon={<ShieldCheck className="size-4" />}
                label={authLabel(authState)}
                ui={ui}
              />
              {authState !== "signed-in" ? (
                <button
                  className={`inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold transition ${ui.primaryButton}`}
                  onClick={signIn}
                >
                  <LogIn className="size-4" />
                  Sign in
                </button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Metric ui={ui} label="Active alerts" value={alerts.length.toString()} />
            <Metric ui={ui} label="Avg conviction" value={`${averageConviction}%`} />
            <Metric
              ui={ui}
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
                detail={
                  authState === "signed-in"
                    ? "No active Supabase alerts are available right now."
                    : "Sign in to read the live Supabase alert feed."
                }
              />
            ) : null}
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                authState={authState}
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
          <div className="space-y-3">
            {trades.length === 0 ? (
              <EmptyState
                ui={ui}
                title="No shadow trades"
                detail="Open a trade from a live alert after signing in."
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
    </main>
  );
}

function AlertCard({
  alert,
  authState,
  isOpened,
  isSubmitting,
  onPaperTrade,
  ui,
}: {
  alert: AlertFeedItem;
  authState: AuthState;
  isOpened: boolean;
  isSubmitting: boolean;
  onPaperTrade: (alert: AlertFeedItem) => void;
  ui: ThemeClasses;
}) {
  const bearish = alert.direction === "bearish";
  const requiresAuth = authState !== "signed-in";
  const isDisabled = isSubmitting || isOpened || authState === "checking";

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
          <h3 className={`mt-3 text-xl font-semibold ${ui.heading}`}>{alert.title}</h3>
          <p className={`mt-2 max-w-3xl text-sm leading-6 ${ui.secondaryText}`}>
            {alert.thesis}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <Conviction score={alert.conviction_score} ui={ui} />
          <button
            className={`inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold transition ${
              isOpened
                ? ui.successButton
                : requiresAuth
                ? ui.outlineButton
                : ui.paperTradeButton
            }`}
            disabled={isDisabled}
            onClick={() => onPaperTrade(alert)}
          >
            {requiresAuth && !isOpened ? (
              <LogIn className="size-4" />
            ) : (
              <Target className="size-4" />
            )}
            {buttonLabel(authState, isSubmitting, isOpened)}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DataTile ui={ui} label="Trigger" value={`Rs. ${numberFormat.format(alert.trigger_price)}`} />
        <DataTile ui={ui} label="Current" value={`Rs. ${numberFormat.format(alert.current_price)}`} />
        <DataTile ui={ui} label="Swept level" value={alert.swept_level_name} />
        <DataTile ui={ui} label="Volume" value={`${alert.volume_multiplier}x`} />
      </div>

      <div className="mt-5 grid gap-2 md:grid-cols-2">
        {alert.score_factors.map((factor) => (
          <div
            key={`${alert.id}-${factor.name}`}
            className={`flex items-center justify-between rounded-md border px-3 py-2 ${ui.subtlePanel}`}
          >
            <div>
              <div className={`text-sm ${ui.heading}`}>{factor.name}</div>
              <div className={`text-xs ${ui.mutedText}`}>{factor.state}</div>
            </div>
            <span className={`font-mono text-sm ${ui.accentText}`}>+{factor.score}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function Conviction({ score, ui }: { score: number; ui: ThemeClasses }) {
  return (
    <div className={`grid size-20 place-items-center rounded-lg border ${ui.convictionBox}`}>
      <div className="text-center">
        <div className={`font-mono text-2xl font-semibold ${ui.accentText}`}>{score}%</div>
        <div className={`mt-1 flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.16em] ${ui.mutedText}`}>
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
  ui,
}: {
  trade: ShadowTradePosition;
  onClose: (trade: ShadowTradePosition) => void;
  ui: ThemeClasses;
}) {
  const positive = trade.unrealized_pnl >= 0;

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
        <div className={`text-right ${positive ? "text-emerald-300" : "text-red-300"}`}>
          <div className="font-mono text-lg font-semibold">
            Rs. {numberFormat.format(trade.unrealized_pnl)}
          </div>
          <div className="text-xs">{numberFormat.format(trade.pnl_percent)}%</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <DataTile ui={ui} label="Entry" value={`Rs. ${numberFormat.format(trade.entry_price)}`} />
        <DataTile ui={ui} label="Mark" value={`Rs. ${numberFormat.format(trade.current_price)}`} />
      </div>
      {trade.status === "open" ? (
        <button
          className={`mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border text-sm font-medium transition ${ui.outlineButton}`}
          onClick={() => onClose(trade)}
        >
          <X className="size-4" />
          Close Shadow Trade
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
      ? "text-emerald-300"
      : tone === "negative"
        ? "text-red-300"
        : "text-stone-50";

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

function StatusPill({
  icon,
  label,
  ui,
}: {
  icon: ReactNode;
  label: string;
  ui: ThemeClasses;
}) {
  return (
    <div className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm ${ui.outlineButton}`}>
      {icon}
      {label}
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

function buttonLabel(
  authState: AuthState,
  isSubmitting: boolean,
  isOpened: boolean,
) {
  if (isOpened) {
    return "Trade Open";
  }

  if (isSubmitting) {
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

type ThemeClasses = ReturnType<typeof getThemeClasses>;

function getThemeClasses(theme: Theme) {
  if (theme === "light") {
    return {
      page: "bg-[#f4f7ef] text-[#11170f]",
      header: "border-stone-300 bg-[#fbfcf7]/95",
      card: "border-stone-300 bg-white text-[#11170f] shadow-black/5",
      subtlePanel: "border-stone-200 bg-[#f5f7ef]",
      toast: "border-stone-300 bg-white text-[#11170f]",
      heading: "text-[#11170f]",
      secondaryText: "text-stone-600",
      mutedText: "text-stone-500",
      accentText: "text-emerald-700",
      primaryButton: "bg-[#11170f] text-white hover:bg-emerald-900",
      paperTradeButton: "bg-[#11170f] text-white hover:bg-emerald-900",
      outlineButton:
        "border-stone-300 bg-white text-stone-700 hover:border-emerald-700 hover:text-emerald-800",
      successButton: "border border-emerald-700/30 bg-emerald-100 text-emerald-800",
      symbolPill: "border-emerald-700/30 text-emerald-800",
      convictionBox: "border-emerald-700/30 bg-emerald-50",
    };
  }

  return {
    page: "bg-[#070907] text-stone-100",
    header: "border-lime-300/10 bg-[#0b0f0b]/95",
    card: "border-stone-800 bg-[#0d120d] text-stone-100 shadow-black/20",
    subtlePanel: "border-stone-800 bg-black/20",
    toast: "border-stone-700 bg-[#101510] text-stone-200",
    heading: "text-stone-50",
    secondaryText: "text-stone-400",
    mutedText: "text-stone-500",
    accentText: "text-lime-300",
    primaryButton: "bg-lime-300 text-[#10140f] hover:bg-lime-200",
    paperTradeButton: "bg-stone-100 text-[#10140f] hover:bg-lime-200",
    outlineButton:
      "border-stone-700 bg-stone-900 text-stone-300 hover:border-lime-300/50 hover:text-lime-200",
    successButton: "border border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
    symbolPill: "border-lime-300/30 text-lime-200",
    convictionBox: "border-lime-300/30 bg-lime-300/5",
  };
}
