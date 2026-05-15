"use client";

import {
  Activity,
  ArrowDown,
  BellRing,
  ChartCandlestick,
  Cloud,
  Database,
  Gauge,
  LineChart,
  LogIn,
  Radar,
  Receipt,
  ShieldAlert,
  Sparkles,
  Target,
  TimerReset,
  TrendingDown,
  WalletCards,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { Theme, ThemeClasses } from "@/lib/theme";

type AuthState = "checking" | "signed-in" | "signed-out" | "unconfigured";

export function LandingContent({
  ui,
  theme,
  authState,
  onSignIn,
}: {
  ui: ThemeClasses;
  theme: Theme;
  authState: AuthState;
  onSignIn: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Scroll-linked CSS vars: dashoffset for the dashed SVG paths,
  // y-offset for the parallax 3D tablet frame.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let ticking = false;

    const update = () => {
      ticking = false;
      const rect = el.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      const total = rect.height - viewport;
      const scrolled = Math.min(Math.max(-rect.top, 0), Math.max(total, 1));
      const progress = total > 0 ? scrolled / total : 0;

      el.style.setProperty("--ms-scroll", progress.toFixed(4));
      el.style.setProperty(
        "--ms-dashoffset",
        `${(-2400 * progress).toFixed(1)}`,
      );
    };

    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // IntersectionObserver-driven reveal-on-scroll.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      el.querySelectorAll(".ms-reveal").forEach((node) =>
        node.classList.add("is-revealed"),
      );
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );

    el.querySelectorAll(".ms-reveal").forEach((node) => observer.observe(node));

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="ms-landing relative" data-ms-theme={theme}>
      <AnimatedBackground />

      <HeroSection ui={ui} authState={authState} onSignIn={onSignIn} />
      <SetupSection ui={ui} />
      <EngineSection ui={ui} />
      <ThesisSection ui={ui} />
      <StackSection ui={ui} />
      <FinalCta ui={ui} authState={authState} onSignIn={onSignIn} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Animated background — fixed layer with parallax tablet + SVG paths */
/* ------------------------------------------------------------------ */

function AnimatedBackground() {
  return (
    <div aria-hidden="true" className="ms-bg-layer">
      <svg
        className="ms-bg-paths"
        viewBox="0 0 1440 1800"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="ms-accent-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ms-accent)" stopOpacity="0.35" />
            <stop offset="40%" stopColor="var(--ms-accent)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--ms-accent)" stopOpacity="0.45" />
          </linearGradient>
          <path
            id="ms-line-1"
            d="M 100,-80 C 220,200 -20,500 100,800 C 220,1100 -20,1400 100,1700 C 180,1860 100,1880 100,1900"
          />
          <path
            id="ms-line-2"
            d="M 120,-80 C 120,360 1320,360 1320,820 C 1320,1280 120,1280 120,1740 C 160,1860 120,1900 120,1900"
          />
          <path
            id="ms-line-3"
            d="M 1320,-80 C 1320,360 120,360 120,820 C 120,1280 1320,1280 1320,1740 C 1280,1860 1320,1900 1320,1900"
          />
          <path
            id="ms-line-4"
            d="M 1340,-80 C 1240,200 1460,500 1340,800 C 1240,1100 1460,1400 1340,1700 C 1260,1860 1340,1880 1340,1900"
          />
        </defs>
        <use href="#ms-line-1" />
        <use href="#ms-line-2" />
        <use href="#ms-line-3" />
        <use href="#ms-line-4" />
      </svg>

      <div
        className="ms-orb absolute -left-32 top-[18%] h-[420px] w-[420px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, var(--ms-accent-glow) 0%, transparent 70%)",
        }}
      />
      <div
        className="ms-orb absolute -right-32 top-[55%] h-[520px] w-[520px] rounded-full blur-3xl"
        style={{
          animationDelay: "-3s",
          background:
            "radial-gradient(circle, var(--ms-accent-mute) 0%, transparent 70%)",
        }}
      />
      <div
        className="absolute inset-x-0 top-0 h-[60vh] opacity-70"
        style={{
          background:
            "radial-gradient(ellipse at 50% -10%, var(--ms-accent-glow) 0%, transparent 60%)",
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[40vh] opacity-50"
        style={{
          background:
            "radial-gradient(ellipse at 50% 110%, var(--ms-accent-mute) 0%, transparent 65%)",
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function HeroSection({
  ui,
  authState,
  onSignIn,
}: {
  ui: ThemeClasses;
  authState: AuthState;
  onSignIn: () => void;
}) {
  return (
    <section className="relative z-10 mx-auto flex max-w-7xl flex-col items-center px-4 pb-24 pt-16 text-center sm:px-6 sm:pt-24 lg:px-8 lg:pt-28">
      <div className="ms-reveal flex items-center gap-2">
        <span className="ms-ticker-dot" />
        <span
          className={`font-mono text-[11px] uppercase tracking-[0.32em] ${ui.accentText}`}
        >
          NSE · live order ticket
        </span>
      </div>

      <h2
        className="ms-reveal mt-7 max-w-5xl text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl"
        style={{ ["--ms-reveal-delay" as string]: "120ms" }}
      >
        <span className={ui.heading}>Catch institutional</span>
        <br />
        <span className="ms-accent-text">liquidity traps</span>
        <span className={ui.heading}> before the reset.</span>
      </h2>

      <p
        className={`ms-reveal mt-6 max-w-2xl text-balance text-base leading-7 sm:text-lg ${ui.secondaryText}`}
        style={{ ["--ms-reveal-delay" as string]: "220ms" }}
      >
        Market Sniper watches NSE intraday for previous-day-high sweeps that
        stall extended from VWAP — the moments fast money fades into
        institutional supply. Every alert ships with an execution-ready order
        ticket: entry, VWAP target, trigger-buffered stop, and a risk-reward
        quality gate.
      </p>

      <div
        className="ms-reveal mt-9 flex flex-wrap items-center justify-center gap-3"
        style={{ ["--ms-reveal-delay" as string]: "320ms" }}
      >
        <button
          className={`ms-glow inline-flex h-12 items-center gap-2 rounded-md px-6 text-sm font-semibold transition ${ui.primaryButton}`}
          onClick={onSignIn}
          type="button"
          disabled={authState === "checking"}
        >
          <LogIn className="size-4" />
          {authState === "checking"
            ? "Checking session..."
            : "Sign in to start scanning"}
        </button>
        <a
          href="#engine"
          className={`inline-flex h-12 items-center gap-2 rounded-md border px-5 text-sm font-medium transition ${ui.outlineButton}`}
        >
          See how it works
          <ArrowDown className="size-4" />
        </a>
      </div>

      <div
        className="ms-reveal mt-12 grid w-full max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4"
        style={{ ["--ms-reveal-delay" as string]: "440ms" }}
      >
        <HeroStat ui={ui} value="VWAP" label="target anchor" />
        <HeroStat ui={ui} value="0.15%" label="buffered stop" />
        <HeroStat ui={ui} value="R:R" label="quality gate" />
        <HeroStat ui={ui} value="realtime" label="Supabase push" />
      </div>

      {authState === "unconfigured" ? (
        <p className={`ms-reveal mt-8 text-sm ${ui.negativeText}`}>
          Supabase env vars are not configured. Set NEXT_PUBLIC_SUPABASE_URL
          and NEXT_PUBLIC_SUPABASE_ANON_KEY to enable sign in.
        </p>
      ) : null}

      <TickerStrip ui={ui} />
    </section>
  );
}

function HeroStat({
  ui,
  value,
  label,
}: {
  ui: ThemeClasses;
  value: string;
  label: string;
}) {
  return (
    <div className={`rounded-md border px-3 py-3 text-left ${ui.card}`}>
      <div
        className={`font-mono text-xs uppercase tracking-[0.18em] ${ui.mutedText}`}
      >
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg font-semibold ${ui.accentText}`}>
        {value}
      </div>
    </div>
  );
}

function TickerStrip({ ui }: { ui: ThemeClasses }) {
  const items = [
    "previous-day-high sweep",
    "VWAP target anchor",
    "0.15% trigger buffer",
    "conviction scoring",
    "shadow trade journal",
    "realtime supabase push",
    "Angel One SmartAPI",
    "NSE hours only",
    "R:R quality gate",
    "RLS-enforced multi-user",
  ];

  return (
    <div
      className={`ms-reveal mt-12 w-full overflow-hidden border-y py-3 ${ui.executionPlanHeader}`}
      style={{ ["--ms-reveal-delay" as string]: "560ms" }}
    >
      <div className="ms-marquee-track flex w-max gap-10 whitespace-nowrap">
        {[...items, ...items].map((it, i) => (
          <span
            key={`${it}-${i}`}
            className={`inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] ${ui.mutedText}`}
          >
            <Sparkles className="size-3" />
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The Setup — what is a liquidity trap                                */
/* ------------------------------------------------------------------ */

function SetupSection({ ui }: { ui: ThemeClasses }) {
  const steps = [
    {
      n: "01",
      icon: <Radar className="size-4" />,
      title: "The sweep",
      body: "Price spikes above the previous day's high, triggering retail breakout buyers and harvesting stop liquidity above the level.",
    },
    {
      n: "02",
      icon: <Activity className="size-4" />,
      title: "The extension",
      body: "Volume confirms institutional participation, but price is now meaningfully extended from session VWAP — the institutional fair-value reference.",
    },
    {
      n: "03",
      icon: <TrendingDown className="size-4" />,
      title: "The fade",
      body: "Without follow-through, the swept level becomes resistance. The trap closes as price reverts to VWAP, taking out the late longs.",
    },
  ];

  return (
    <section className="relative z-10 mx-auto max-w-7xl px-4 py-28 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <p
          className={`ms-reveal font-mono text-[11px] uppercase tracking-[0.32em] ${ui.accentText}`}
        >
          The Setup
        </p>
        <h3
          className={`ms-reveal mt-4 text-3xl font-semibold sm:text-4xl ${ui.heading}`}
          style={{ ["--ms-reveal-delay" as string]: "80ms" }}
        >
          A liquidity trap is a textbook three-act drama.
        </h3>
        <p
          className={`ms-reveal mt-3 text-base leading-7 ${ui.secondaryText}`}
          style={{ ["--ms-reveal-delay" as string]: "160ms" }}
        >
          You don&apos;t need to be early — you need to be on the right side of
          the fade. Market Sniper exists to surface the precise moment Act 2
          finishes and Act 3 begins.
        </p>
      </div>

      <div className="mt-14 grid gap-5 md:grid-cols-3">
        {steps.map((step, i) => (
          <div
            key={step.n}
            className={`ms-reveal relative overflow-hidden rounded-xl border p-6 ${ui.card}`}
            style={{ ["--ms-reveal-delay" as string]: `${i * 140}ms` }}
          >
            <div
              className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em] ${ui.mutedText}`}
            >
              <span>{step.n}</span>
              <span className="h-px flex-1 bg-current opacity-30" />
              <span className={ui.accentText}>{step.icon}</span>
            </div>
            <h4 className={`mt-5 text-xl font-semibold ${ui.heading}`}>
              {step.title}
            </h4>
            <p className={`mt-2 text-sm leading-6 ${ui.secondaryText}`}>
              {step.body}
            </p>

            <TrapChart ui={ui} stage={i} />
          </div>
        ))}
      </div>
    </section>
  );
}

function TrapChart({ ui, stage }: { ui: ThemeClasses; stage: 0 | 1 | 2 | number }) {
  // Hand-drawn schematic showing the setup at each act.
  return (
    <svg
      viewBox="0 0 200 90"
      className={`mt-6 h-24 w-full ${ui.mutedText}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <line
        x1="0"
        y1="38"
        x2="200"
        y2="38"
        strokeDasharray="3 3"
        stroke="#f59e0b"
        opacity="0.7"
      />
      <line
        x1="0"
        y1="58"
        x2="200"
        y2="58"
        strokeDasharray="2 4"
        stroke="var(--ms-accent)"
        opacity="0.6"
      />
      <text x="2" y="34" fontSize="8" fill="#f59e0b">
        PDH
      </text>
      <text x="2" y="68" fontSize="8" fill="var(--ms-accent)">
        VWAP
      </text>

      <path
        d="M 0,62 L 30,60 L 50,52 L 80,48"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.7"
      />
      {stage >= 1 ? (
        <path
          d="M 80,48 L 100,32 L 115,28 L 130,34"
          stroke="#ef4444"
          strokeWidth="1.8"
        />
      ) : null}
      {stage >= 2 ? (
        <path
          d="M 130,34 L 150,42 L 170,54 L 195,62"
          stroke="#ef4444"
          strokeWidth="1.8"
        />
      ) : null}
      {stage >= 2 ? (
        <circle
          cx="170"
          cy="54"
          r="2.6"
          fill="#ef4444"
          className="ms-pulse"
        />
      ) : null}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The Engine — code-display cards (codepen-style)                     */
/* ------------------------------------------------------------------ */

type EngineCard = {
  tag: string;
  title: string;
  icon: ReactNode;
  description: string;
  code: string;
};

function EngineSection({ ui }: { ui: ThemeClasses }) {
  const cards: EngineCard[] = [
    {
      tag: "DETECTION",
      title: "VWAP extension filter",
      icon: <Radar className="size-3.5" />,
      description:
        "An edge function scans every instrument each minute. A setup only qualifies once price has swept the previous day's high AND closed >= 0.25% above session VWAP.",
      code: `const distanceToVwap =
  ((last_price - vwap) / vwap) * 100;

const sweptHigh =
  last_price > previous_day_high;

if (!sweptHigh || distanceToVwap < 0.25) {
  continue;
}`,
    },
    {
      tag: "EXECUTION",
      title: "Order ticket math",
      icon: <Receipt className="size-3.5" />,
      description:
        "Every alert produces a complete, deterministic order ticket. Stops are anchored to the swept level + a 0.15% buffer so noise doesn't take you out.",
      code: `const stopLoss = bearish
  ? trigger_price * 1.0015
  : trigger_price * 0.9985;

const target = vwap;
const margin = entry - vwap;
const risk   = stopLoss - entry;
const rr     = margin / risk;`,
    },
    {
      tag: "REALTIME",
      title: "Postgres → React in <100ms",
      icon: <Zap className="size-3.5" />,
      description:
        "Supabase Realtime streams INSERT / UPDATE events from the alerts table straight into the dashboard. No polling, no stale data, no refresh button.",
      code: `supabase
  .channel("alerts")
  .on("postgres_changes", {
    event: "*",
    table: "alerts",
  }, refreshAlerts)
  .subscribe();`,
    },
    {
      tag: "DISCIPLINE",
      title: "Risk-reward quality gate",
      icon: <ShieldAlert className="size-3.5" />,
      description:
        "The ticket gates every trade on a R:R quality chip before you can click. POOR setups stare back at you in red — discipline by default, not willpower.",
      code: `function classifyRr(rr) {
  if (rr >= 2) return "GOOD";
  if (rr >= 1) return "MARGINAL";
  return "POOR";
}`,
    },
  ];

  return (
    <section
      id="engine"
      className="relative z-10 mx-auto max-w-7xl px-4 py-28 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-3xl text-center">
        <p
          className={`ms-reveal font-mono text-[11px] uppercase tracking-[0.32em] ${ui.accentText}`}
        >
          The Engine
        </p>
        <h3
          className={`ms-reveal mt-4 text-3xl font-semibold sm:text-4xl ${ui.heading}`}
          style={{ ["--ms-reveal-delay" as string]: "80ms" }}
        >
          Four pieces of code, one disciplined system.
        </h3>
        <p
          className={`ms-reveal mt-3 text-base leading-7 ${ui.secondaryText}`}
          style={{ ["--ms-reveal-delay" as string]: "160ms" }}
        >
          No screenshots — the actual code that powers detection, execution
          math, realtime delivery, and the risk gate.
        </p>
      </div>

      <div className="relative mt-16 grid gap-10 md:grid-cols-2">
        {cards.map((card, i) => (
          <CodeCard key={card.tag} ui={ui} card={card} index={i} />
        ))}
      </div>
    </section>
  );
}

function CodeCard({
  ui,
  card,
  index,
}: {
  ui: ThemeClasses;
  card: EngineCard;
  index: number;
}) {
  const offset = index % 2 === 0 ? "md:translate-y-4" : "md:-translate-y-6";

  return (
    <div
      className={`ms-reveal ms-drift relative ${offset} overflow-hidden rounded-2xl border ${ui.executionPlan}`}
      style={{ ["--ms-reveal-delay" as string]: `${index * 120}ms` }}
    >
      <div
        className="absolute -inset-px -z-10 opacity-70 blur-[22px]"
        style={{
          background:
            "radial-gradient(ellipse at top left, var(--ms-accent-glow) 0%, transparent 70%)",
        }}
      />
      <header
        className={`flex items-center justify-between border-b px-5 py-3 ${ui.executionPlanHeader}`}
      >
        <span
          className={`inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] ${ui.accentText}`}
        >
          {card.icon}
          {card.tag}
        </span>
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.2em] ${ui.mutedText}`}
        >
          src/
        </span>
      </header>

      <div className="px-5 py-5">
        <h4 className={`text-lg font-semibold ${ui.heading}`}>{card.title}</h4>
        <p className={`mt-2 text-sm leading-6 ${ui.secondaryText}`}>
          {card.description}
        </p>

        <pre
          className={`mt-5 overflow-x-auto rounded-md border px-4 py-3 font-mono text-[12px] leading-6 ${ui.subtlePanel}`}
        >
          <code className="ms-accent-text">{card.code}</code>
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Thesis — Anatomy of an alert (annotated ticket mockup)              */
/* ------------------------------------------------------------------ */

function ThesisSection({ ui }: { ui: ThemeClasses }) {
  return (
    <section className="relative z-10 mx-auto max-w-7xl px-4 py-28 sm:px-6 lg:px-8">
      <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)] lg:items-center">
        <div>
          <p
            className={`ms-reveal font-mono text-[11px] uppercase tracking-[0.32em] ${ui.accentText}`}
          >
            Anatomy of an alert
          </p>
          <h3
            className={`ms-reveal mt-4 text-3xl font-semibold sm:text-4xl ${ui.heading}`}
            style={{ ["--ms-reveal-delay" as string]: "80ms" }}
          >
            Built like an institutional order ticket, not a notification.
          </h3>
          <p
            className={`ms-reveal mt-4 text-base leading-7 ${ui.secondaryText}`}
            style={{ ["--ms-reveal-delay" as string]: "160ms" }}
          >
            Each alert is a single, decision-ready surface. Conviction scoring,
            volume context, exact entry, VWAP-anchored target, buffered stop,
            and a risk-reward quality gate — all in one card. You either click
            <span className={ui.heading}> Paper Trade</span>, or you don&apos;t.
            No ambiguity.
          </p>

          <ul className="mt-7 space-y-4">
            <ThesisRow
              ui={ui}
              icon={<Gauge className="size-4" />}
              title="Conviction score"
              detail="62–95% scored from VWAP distance, volume multiplier, and timeframe alignment."
            />
            <ThesisRow
              ui={ui}
              icon={<Target className="size-4" />}
              title="VWAP target"
              detail="Take profit is anchored to session VWAP — the institutional reset price."
            />
            <ThesisRow
              ui={ui}
              icon={<ShieldAlert className="size-4" />}
              title="Buffered stop"
              detail="Stop loss sits 0.15% past the trigger so wick noise doesn't liquidate the idea."
            />
            <ThesisRow
              ui={ui}
              icon={<WalletCards className="size-4" />}
              title="Shadow trade journal"
              detail="One-click paper trades open against live Angel One marks, tracked until you close."
            />
          </ul>
        </div>

        <div
          className="ms-reveal ms-drift"
          style={{ ["--ms-reveal-delay" as string]: "120ms" }}
        >
          <MockTicket ui={ui} />
        </div>
      </div>
    </section>
  );
}

function ThesisRow({
  ui,
  icon,
  title,
  detail,
}: {
  ui: ThemeClasses;
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <li className="ms-reveal flex items-start gap-3">
      <span
        className={`mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md border ${ui.subtlePanel} ${ui.accentText}`}
      >
        {icon}
      </span>
      <div>
        <div className={`text-sm font-semibold ${ui.heading}`}>{title}</div>
        <div className={`mt-0.5 text-sm leading-6 ${ui.secondaryText}`}>
          {detail}
        </div>
      </div>
    </li>
  );
}

function MockTicket({ ui }: { ui: ThemeClasses }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border-2 shadow-2xl ${ui.executionPlan}`}
    >
      <div
        className={`flex items-center justify-between border-b px-4 py-2 ${ui.executionPlanHeader}`}
      >
        <span className="inline-flex items-center gap-2">
          <Receipt className="size-4" />
          <span className="font-mono text-xs uppercase tracking-[0.22em]">
            Trade Execution Plan
          </span>
        </span>
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.2em] ${ui.mutedText}`}
        >
          NSE:RELIANCE · 14s ago
        </span>
      </div>

      <div className="grid gap-3 px-4 py-4 md:grid-cols-3">
        <MockCell ui={ui} label="Action">
          <span
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-bold tracking-wider ${ui.shortPill}`}
          >
            <TrendingDown className="size-3.5" />
            SHORT ENTRY
          </span>
          <div className={`mt-2 font-mono text-lg font-semibold ${ui.heading}`}>
            @ ₹2,496.30
          </div>
        </MockCell>

        <MockCell ui={ui} label="Take Profit" icon={<Target className={`size-3.5 ${ui.positiveText}`} />}>
          <div className={`mt-2 font-mono text-lg font-semibold ${ui.positiveText}`}>
            ₹2,478.10
          </div>
          <div className={`mt-1 flex items-center justify-between text-xs ${ui.positiveText}`}>
            <span>+18.20 pts</span>
            <span className="font-mono">+0.73%</span>
          </div>
        </MockCell>

        <MockCell ui={ui} label="Stop Loss" icon={<ShieldAlert className={`size-3.5 ${ui.negativeText}`} />}>
          <div className={`mt-2 font-mono text-lg font-semibold ${ui.negativeText}`}>
            ₹2,500.04
          </div>
          <div className={`mt-1 flex items-center justify-between text-xs ${ui.negativeText}`}>
            <span>−3.74 pts</span>
            <span className="font-mono">−0.15%</span>
          </div>
        </MockCell>
      </div>

      <div
        className={`flex items-center justify-between border-t px-4 py-2 ${ui.executionPlanHeader}`}
      >
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.2em] ${ui.mutedText}`}
        >
          Risk : Reward
        </span>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-sm font-semibold ${ui.accentText}`}>
            4.87 : 1
          </span>
          <span
            className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold tracking-[0.18em] ${ui.qualityGood}`}
          >
            GOOD
          </span>
        </div>
      </div>
    </div>
  );
}

function MockCell({
  ui,
  label,
  icon,
  children,
}: {
  ui: ThemeClasses;
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-md border px-3 py-3 ${ui.subtlePanel}`}>
      <div className="flex items-center justify-between">
        <div
          className={`text-[10px] uppercase tracking-[0.18em] ${ui.mutedText}`}
        >
          {label}
        </div>
        {icon}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stack                                                               */
/* ------------------------------------------------------------------ */

function StackSection({ ui }: { ui: ThemeClasses }) {
  const stack = [
    {
      icon: <Database className="size-4" />,
      title: "Supabase Postgres",
      detail: "Alerts, instruments, shadow trades — schema-versioned migrations, row-level security on every read.",
    },
    {
      icon: <Cloud className="size-4" />,
      title: "Supabase Edge Functions",
      detail: "Deno runtime hosts the price refresh and alert scanner. NSE-hours-only cron triggers keep the feed clean.",
    },
    {
      icon: <ChartCandlestick className="size-4" />,
      title: "Angel One SmartAPI",
      detail: "Live NSE quotes — last price, volume, intraday VWAP — drive both the scanner and shadow trade marks.",
    },
    {
      icon: <BellRing className="size-4" />,
      title: "Supabase Realtime",
      detail: "Postgres changefeeds stream alert inserts and trade updates straight into the React dashboard.",
    },
    {
      icon: <LineChart className="size-4" />,
      title: "Next.js 16 + Tailwind v4",
      detail: "App router, server components where it helps, single-page client shell where it matters.",
    },
    {
      icon: <TimerReset className="size-4" />,
      title: "Self-expiring alerts",
      detail: "Stale setups auto-expire via cron. The feed reflects the current session — nothing more.",
    },
  ];

  return (
    <section className="relative z-10 mx-auto max-w-7xl px-4 py-28 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <p
          className={`ms-reveal font-mono text-[11px] uppercase tracking-[0.32em] ${ui.accentText}`}
        >
          The Stack
        </p>
        <h3
          className={`ms-reveal mt-4 text-3xl font-semibold sm:text-4xl ${ui.heading}`}
          style={{ ["--ms-reveal-delay" as string]: "80ms" }}
        >
          Boring infrastructure. Disciplined math. Live data.
        </h3>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {stack.map((item, i) => (
          <div
            key={item.title}
            className={`ms-reveal rounded-xl border p-5 ${ui.card}`}
            style={{ ["--ms-reveal-delay" as string]: `${(i % 3) * 100}ms` }}
          >
            <div
              className={`inline-flex size-9 items-center justify-center rounded-md border ${ui.subtlePanel} ${ui.accentText}`}
            >
              {item.icon}
            </div>
            <h4 className={`mt-4 text-base font-semibold ${ui.heading}`}>
              {item.title}
            </h4>
            <p className={`mt-2 text-sm leading-6 ${ui.secondaryText}`}>
              {item.detail}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Final CTA                                                           */
/* ------------------------------------------------------------------ */

function FinalCta({
  ui,
  authState,
  onSignIn,
}: {
  ui: ThemeClasses;
  authState: AuthState;
  onSignIn: () => void;
}) {
  return (
    <section className="relative z-10 mx-auto max-w-7xl px-4 pb-32 pt-12 sm:px-6 lg:px-8">
      <div
        className={`ms-reveal relative overflow-hidden rounded-3xl border-2 p-10 text-center sm:p-16 ${ui.executionPlan}`}
      >
        <div
          className="absolute -inset-1 -z-10 opacity-70 blur-3xl"
          style={{
            background:
              "radial-gradient(circle at 30% 20%, var(--ms-accent-glow) 0%, transparent 65%)",
          }}
        />
        <p
          className={`font-mono text-[11px] uppercase tracking-[0.32em] ${ui.accentText}`}
        >
          The next session is already loaded
        </p>
        <h3 className={`mt-4 text-3xl font-semibold sm:text-5xl ${ui.heading}`}>
          Start scanning with a{" "}
          <span className="ms-accent-text">single click</span>.
        </h3>
        <p
          className={`mx-auto mt-4 max-w-xl text-base leading-7 ${ui.secondaryText}`}
        >
          Magic-link sign in — no password, no setup, no credit card. Your
          shadow trade journal is isolated by row-level security; nobody else
          sees your positions.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <button
            className={`ms-glow inline-flex h-12 items-center gap-2 rounded-md px-6 text-sm font-semibold transition ${ui.primaryButton}`}
            onClick={onSignIn}
            type="button"
            disabled={authState === "checking"}
          >
            <LogIn className="size-4" />
            {authState === "checking"
              ? "Checking session..."
              : "Sign in to start scanning"}
          </button>
          <span
            className={`font-mono text-[11px] uppercase tracking-[0.18em] ${ui.mutedText}`}
          >
            Magic link · NSE hours only · paper trades by default
          </span>
        </div>
      </div>
    </section>
  );
}
