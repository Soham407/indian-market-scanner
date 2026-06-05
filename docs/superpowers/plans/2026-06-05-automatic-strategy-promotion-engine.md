# Automatic Strategy Promotion Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a paper-only signal queue, executor, and feedback engine that automatically promotes, reduces, or disables strategies based on measured paper/shadow performance.

**Architecture:** Strategy detectors enqueue `bot_trade_signals`; only `bot-signal-executor` can create `bot_paper_trades`. `bot-feedback-run` evaluates signal outcomes and closed trades, updates strategy lifecycle/risk controls, records review decisions, and sends Telegram notifications through the existing shared helper.

**Tech Stack:** Supabase PostgreSQL migrations, Supabase Edge Functions on Deno, TypeScript pure helper modules with Deno tests, existing `bot_settings`, `bot_paper_trades`, `bot_incidents`, and Telegram shared helper.

---

## File Structure

- Create `supabase/migrations/20260605120000_bot_strategy_promotion_engine.sql`
  - Extends `bot_strategies`.
  - Creates `bot_trade_signals`, `bot_signal_outcomes`, and `bot_strategy_reviews`.
  - Adds RLS read policies for authenticated users.
  - Adds Realtime publication entries for the new tables.
  - Adds cron schedules for `bot-signal-executor` and `bot-feedback-run`.
- Create `supabase/functions/bot-signal-executor/executor.ts`
  - Pure validation, price/slippage, lifecycle, and trade-construction helpers.
- Create `supabase/functions/bot-signal-executor/executor.test.ts`
  - Deno tests for kill switch, shadow mode, paper-live mode, duplicates, invalid signals, risk cap.
- Create `supabase/functions/bot-signal-executor/index.ts`
  - Edge Function handler that reads pending signals and writes outcomes/trades.
- Create `supabase/functions/bot-feedback-run/feedback.ts`
  - Pure metric and lifecycle transition helpers.
- Create `supabase/functions/bot-feedback-run/feedback.test.ts`
  - Deno tests for profit factor, promotion, reduction, disable, risk cap.
- Create `supabase/functions/bot-feedback-run/index.ts`
  - Edge Function handler that reviews strategies and writes review rows.
- Modify `supabase/functions/orb-scanner/index.ts`
  - Stop inserting `bot_paper_trades` directly.
  - Insert ORB rows into `bot_trade_signals`.
- Modify `supabase/functions/check-exits/index.ts`
  - After closing a paper trade, update linked `bot_signal_outcomes`.
  - Fix exit slippage so slippage is always against the trade.
- Modify `supabase/functions/eod-flatten/index.ts`
  - After EOD close, update linked `bot_signal_outcomes`.
  - Use `bot_settings` for circuit breaker/trading disable instead of `bot_config`.

---

### Task 1: Migration for Strategy Lifecycle and Signal Queue

**Files:**
- Create: `supabase/migrations/20260605120000_bot_strategy_promotion_engine.sql`

- [ ] **Step 1: Create the migration**

Add this file:

```sql
alter table public.bot_strategies
  add column if not exists lifecycle_status text not null default 'research',
  add column if not exists enabled boolean not null default false,
  add column if not exists risk_multiplier numeric(8, 4) not null default 0.25,
  add column if not exists max_risk_multiplier numeric(8, 4) not null default 1.5,
  add column if not exists promotion_thresholds jsonb not null default '{}'::jsonb,
  add column if not exists last_reviewed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bot_strategies_lifecycle_status_check'
  ) then
    alter table public.bot_strategies
      add constraint bot_strategies_lifecycle_status_check
      check (lifecycle_status in ('research', 'shadow', 'paper_live_small', 'paper_live_normal', 'reduced', 'disabled'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bot_strategies_risk_multiplier_cap_check'
  ) then
    alter table public.bot_strategies
      add constraint bot_strategies_risk_multiplier_cap_check
      check (
        risk_multiplier >= 0
        and risk_multiplier <= 1.5
        and max_risk_multiplier >= 0
        and max_risk_multiplier <= 1.5
        and risk_multiplier <= max_risk_multiplier
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bot_strategies_promotion_thresholds_object_check'
  ) then
    alter table public.bot_strategies
      add constraint bot_strategies_promotion_thresholds_object_check
      check (jsonb_typeof(promotion_thresholds) = 'object');
  end if;
end $$;

create table if not exists public.bot_trade_signals (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete restrict,
  source text not null,
  instrument_id uuid not null references public.instruments(id) on delete restrict,
  side text not null,
  signal_time timestamptz not null default now(),
  trigger_price numeric(14, 4) not null,
  stop_loss_price numeric(14, 4) not null,
  target_price numeric(14, 4) not null,
  timeframe text not null default '1m',
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  rejection_reason text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_trade_signals_side_check check (side in ('long', 'short')),
  constraint bot_trade_signals_status_check check (status in ('pending', 'shadow_tracked', 'accepted', 'rejected', 'expired')),
  constraint bot_trade_signals_positive_prices_check check (
    trigger_price > 0 and stop_loss_price > 0 and target_price > 0
  ),
  constraint bot_trade_signals_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.bot_signal_outcomes (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.bot_trade_signals(id) on delete cascade,
  paper_trade_id uuid references public.bot_paper_trades(id) on delete set null,
  mode text not null,
  entry_price numeric(14, 4) not null,
  exit_price numeric(14, 4),
  exit_reason text,
  gross_pnl numeric(14, 4),
  net_pnl numeric(14, 4),
  r_multiple numeric(14, 6),
  max_favorable_excursion numeric(14, 4),
  max_adverse_excursion numeric(14, 4),
  duration_minutes integer,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_signal_outcomes_mode_check check (mode in ('shadow', 'paper_live')),
  constraint bot_signal_outcomes_status_check check (status in ('open', 'closed')),
  constraint bot_signal_outcomes_positive_entry_check check (entry_price > 0),
  constraint bot_signal_outcomes_duration_check check (duration_minutes is null or duration_minutes >= 0)
);

create table if not exists public.bot_strategy_reviews (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.bot_strategies(id) on delete cascade,
  reviewed_at timestamptz not null default now(),
  window_start timestamptz not null,
  window_end timestamptz not null,
  sample_count integer not null,
  profit_factor numeric(14, 6),
  win_rate numeric(8, 4),
  average_r numeric(14, 6),
  max_drawdown numeric(14, 4),
  rejection_rate numeric(8, 4),
  previous_status text not null,
  new_status text not null,
  previous_risk_multiplier numeric(8, 4),
  new_risk_multiplier numeric(8, 4),
  decision text not null,
  rationale text not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint bot_strategy_reviews_sample_count_check check (sample_count >= 0),
  constraint bot_strategy_reviews_metrics_object_check check (jsonb_typeof(metrics) = 'object')
);

create index if not exists bot_trade_signals_status_signal_time_idx
  on public.bot_trade_signals (status, signal_time);

create index if not exists bot_trade_signals_strategy_instrument_time_idx
  on public.bot_trade_signals (strategy_id, instrument_id, signal_time);

create index if not exists bot_signal_outcomes_signal_id_idx
  on public.bot_signal_outcomes (signal_id);

create index if not exists bot_signal_outcomes_trade_id_idx
  on public.bot_signal_outcomes (paper_trade_id);

create index if not exists bot_strategy_reviews_strategy_reviewed_idx
  on public.bot_strategy_reviews (strategy_id, reviewed_at desc);

drop trigger if exists bot_trade_signals_set_updated_at on public.bot_trade_signals;
create trigger bot_trade_signals_set_updated_at
before update on public.bot_trade_signals
for each row execute function public.bot_set_updated_at();

drop trigger if exists bot_signal_outcomes_set_updated_at on public.bot_signal_outcomes;
create trigger bot_signal_outcomes_set_updated_at
before update on public.bot_signal_outcomes
for each row execute function public.bot_set_updated_at();

alter table public.bot_trade_signals enable row level security;
alter table public.bot_signal_outcomes enable row level security;
alter table public.bot_strategy_reviews enable row level security;

grant select on public.bot_trade_signals to authenticated;
grant select on public.bot_signal_outcomes to authenticated;
grant select on public.bot_strategy_reviews to authenticated;

drop policy if exists "Authenticated users can read bot trade signals" on public.bot_trade_signals;
create policy "Authenticated users can read bot trade signals"
  on public.bot_trade_signals for select to authenticated using (true);

drop policy if exists "Authenticated users can read bot signal outcomes" on public.bot_signal_outcomes;
create policy "Authenticated users can read bot signal outcomes"
  on public.bot_signal_outcomes for select to authenticated using (true);

drop policy if exists "Authenticated users can read bot strategy reviews" on public.bot_strategy_reviews;
create policy "Authenticated users can read bot strategy reviews"
  on public.bot_strategy_reviews for select to authenticated using (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.bot_trade_signals;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.bot_signal_outcomes;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.bot_strategy_reviews;
  exception when duplicate_object then null;
  end;
end $$;

update public.bot_strategies
set
  enabled = true,
  lifecycle_status = case
    when lifecycle_status = 'research' then 'paper_live_small'
    else lifecycle_status
  end,
  risk_multiplier = least(greatest(risk_multiplier, 0.25), 1.5),
  max_risk_multiplier = least(max_risk_multiplier, 1.5),
  promotion_thresholds = promotion_thresholds || jsonb_build_object(
    'shadow_min_outcomes', 30,
    'shadow_min_profit_factor', 1.10,
    'normal_min_live_trades', 30,
    'normal_min_profit_factor', 1.20,
    'reduced_profit_factor', 1.00
  )
where name = 'orb_breakout';

create schema if not exists extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule(jobid)
from cron.job
where jobname in ('bot-signal-executor-every-minute', 'bot-feedback-weekly-friday');

select cron.schedule(
  'bot-signal-executor-every-minute',
  '* 3,4,5,6,7,8,9,10 * * 1-5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/bot-signal-executor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'bot_anon_jwt' limit 1),
        (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
      )
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);

select cron.schedule(
  'bot-feedback-weekly-friday',
  '45 10 * * 5',
  $$
  select net.http_post(
    url := coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'bot_project_url' limit 1),
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_project_url' limit 1)
    ) || '/functions/v1/bot-feedback-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'bot_anon_jwt' limit 1),
        (select decrypted_secret from vault.decrypted_secrets where name = 'market_sniper_anon_jwt' limit 1)
      )
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
```

- [ ] **Step 2: Verify the migration SQL parses locally if Supabase CLI is available**

Run:

```bash
supabase db lint
```

Expected: no parser errors for `20260605120000_bot_strategy_promotion_engine.sql`. If Supabase is not linked locally, record that and continue with unit tests.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260605120000_bot_strategy_promotion_engine.sql
git commit -m "RALPH: add bot strategy promotion schema"
```

---

### Task 2: Pure Executor Logic

**Files:**
- Create: `supabase/functions/bot-signal-executor/executor.ts`
- Test: `supabase/functions/bot-signal-executor/executor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/bot-signal-executor/executor.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyEntrySlippage,
  buildExecutorDecision,
  calculateShares,
  capRiskMultiplier,
  validateSignalShape,
  type ExecutorContext,
  type SignalRow,
  type StrategyRow,
} from "./executor.ts";

const baseSignal: SignalRow = {
  id: "signal-1",
  strategy_id: "strategy-1",
  instrument_id: "instrument-1",
  source: "orb_breakout",
  side: "long",
  trigger_price: 100,
  stop_loss_price: 95,
  target_price: 110,
  signal_time: "2026-06-05T04:00:00.000Z",
  metadata: {},
};

const liveStrategy: StrategyRow = {
  id: "strategy-1",
  name: "orb_breakout",
  enabled: true,
  lifecycle_status: "paper_live_small",
  risk_multiplier: 0.25,
  max_risk_multiplier: 1.5,
};

const context: ExecutorContext = {
  tradingEnabled: true,
  baseRiskAmount: 1000,
  maxConcurrentPositions: 2,
  maxTradesPerDay: 6,
  openPositionCount: 0,
  tradesTodayCount: 0,
  hasDuplicateForInstrumentToday: false,
  latestPrice: 100,
  nowIso: "2026-06-05T04:01:00.000Z",
};

Deno.test("validateSignalShape rejects invalid long stop and target geometry", () => {
  assertEquals(validateSignalShape({ ...baseSignal, stop_loss_price: 101 }).ok, false);
  assertEquals(validateSignalShape({ ...baseSignal, target_price: 99 }).ok, false);
});

Deno.test("validateSignalShape rejects invalid short stop and target geometry", () => {
  const shortSignal = { ...baseSignal, side: "short" as const, trigger_price: 100, stop_loss_price: 95, target_price: 110 };
  assertEquals(validateSignalShape(shortSignal).ok, false);
});

Deno.test("capRiskMultiplier never exceeds 1.5", () => {
  assertEquals(capRiskMultiplier(2, 2), 1.5);
  assertEquals(capRiskMultiplier(1.25, 2), 1.25);
});

Deno.test("applyEntrySlippage applies slippage against long and short entries", () => {
  assertEquals(applyEntrySlippage("long", 100), 100.05);
  assertEquals(applyEntrySlippage("short", 100), 99.95);
});

Deno.test("calculateShares sizes from effective risk and per-share risk", () => {
  assertEquals(calculateShares(1000, 0.25, 100.05, 95), 49);
});

Deno.test("buildExecutorDecision creates shadow outcome without paper trade", () => {
  const decision = buildExecutorDecision(
    baseSignal,
    { ...liveStrategy, lifecycle_status: "shadow" },
    { ...context, tradingEnabled: false },
  );
  assertEquals(decision.action, "shadow");
});

Deno.test("buildExecutorDecision rejects paper entry when kill switch is disabled", () => {
  const decision = buildExecutorDecision(baseSignal, liveStrategy, { ...context, tradingEnabled: false });
  assertEquals(decision.action, "reject");
  assertEquals(decision.reason, "trading disabled");
});

Deno.test("buildExecutorDecision accepts live paper strategy and caps risk", () => {
  const decision = buildExecutorDecision(
    baseSignal,
    { ...liveStrategy, risk_multiplier: 3, max_risk_multiplier: 3 },
    context,
  );
  assertEquals(decision.action, "paper_trade");
  if (decision.action !== "paper_trade") throw new Error("expected paper trade");
  assertEquals(decision.riskAmount, 1500);
  assertEquals(decision.shares, 297);
});

Deno.test("buildExecutorDecision rejects duplicate same-instrument day trade", () => {
  const decision = buildExecutorDecision(baseSignal, liveStrategy, {
    ...context,
    hasDuplicateForInstrumentToday: true,
  });
  assertEquals(decision.action, "reject");
  assertEquals(decision.reason, "duplicate instrument for strategy today");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
deno test supabase/functions/bot-signal-executor/executor.test.ts
```

Expected: failure because `executor.ts` does not exist.

- [ ] **Step 3: Implement pure executor helpers**

Create `supabase/functions/bot-signal-executor/executor.ts`:

```ts
export type SignalSide = "long" | "short";
export type LifecycleStatus = "research" | "shadow" | "paper_live_small" | "paper_live_normal" | "reduced" | "disabled";

export type SignalRow = {
  id: string;
  strategy_id: string;
  instrument_id: string;
  source: string;
  side: SignalSide;
  trigger_price: number;
  stop_loss_price: number;
  target_price: number;
  signal_time: string;
  metadata: Record<string, unknown>;
};

export type StrategyRow = {
  id: string;
  name: string;
  enabled: boolean;
  lifecycle_status: LifecycleStatus;
  risk_multiplier: number;
  max_risk_multiplier: number;
};

export type ExecutorContext = {
  tradingEnabled: boolean;
  baseRiskAmount: number;
  maxConcurrentPositions: number;
  maxTradesPerDay: number;
  openPositionCount: number;
  tradesTodayCount: number;
  hasDuplicateForInstrumentToday: boolean;
  latestPrice: number | null;
  nowIso: string;
};

export type ExecutorDecision =
  | { action: "reject"; reason: string }
  | { action: "shadow"; entryPrice: number; riskAmount: number }
  | {
    action: "paper_trade";
    entryPrice: number;
    stopLossPrice: number;
    targetPrice: number;
    shares: number;
    riskAmount: number;
    entrySlippagePct: number;
  };

const ENTRY_SLIPPAGE_RATE = 0.0005;
const MAX_RISK_MULTIPLIER = 1.5;
const PRICE_SANITY_PCT = 0.05;

export function capRiskMultiplier(riskMultiplier: number, maxRiskMultiplier: number): number {
  const bounded = Math.min(riskMultiplier, maxRiskMultiplier, MAX_RISK_MULTIPLIER);
  return Math.max(0, bounded);
}

export function applyEntrySlippage(side: SignalSide, triggerPrice: number): number {
  const raw = side === "long"
    ? triggerPrice * (1 + ENTRY_SLIPPAGE_RATE)
    : triggerPrice * (1 - ENTRY_SLIPPAGE_RATE);
  return Number(raw.toFixed(4));
}

export function calculateShares(
  baseRiskAmount: number,
  riskMultiplier: number,
  entryPrice: number,
  stopLossPrice: number,
): number {
  const riskPerShare = Math.abs(entryPrice - stopLossPrice);
  if (riskPerShare <= 0) return 0;
  return Math.floor((baseRiskAmount * riskMultiplier) / riskPerShare);
}

export function validateSignalShape(signal: SignalRow): { ok: true } | { ok: false; reason: string } {
  if (signal.trigger_price <= 0 || signal.stop_loss_price <= 0 || signal.target_price <= 0) {
    return { ok: false, reason: "signal prices must be positive" };
  }

  if (signal.side === "long") {
    if (signal.stop_loss_price >= signal.trigger_price) return { ok: false, reason: "long stop must be below trigger" };
    if (signal.target_price <= signal.trigger_price) return { ok: false, reason: "long target must be above trigger" };
  } else {
    if (signal.stop_loss_price <= signal.trigger_price) return { ok: false, reason: "short stop must be above trigger" };
    if (signal.target_price >= signal.trigger_price) return { ok: false, reason: "short target must be below trigger" };
  }

  return { ok: true };
}

function isPaperLive(status: LifecycleStatus): boolean {
  return status === "paper_live_small" || status === "paper_live_normal" || status === "reduced";
}

function hasSanePrice(signalPrice: number, latestPrice: number | null): boolean {
  if (latestPrice === null || latestPrice <= 0) return true;
  return Math.abs(signalPrice - latestPrice) / latestPrice <= PRICE_SANITY_PCT;
}

export function buildExecutorDecision(
  signal: SignalRow,
  strategy: StrategyRow,
  context: ExecutorContext,
): ExecutorDecision {
  const shape = validateSignalShape(signal);
  if (!shape.ok) return { action: "reject", reason: shape.reason };

  if (!strategy.enabled || strategy.lifecycle_status === "disabled") {
    return { action: "reject", reason: "strategy disabled" };
  }

  if (strategy.lifecycle_status === "research") {
    return { action: "reject", reason: "strategy is research only" };
  }

  if (!hasSanePrice(signal.trigger_price, context.latestPrice)) {
    return { action: "reject", reason: "trigger price outside sanity bounds" };
  }

  const riskMultiplier = capRiskMultiplier(strategy.risk_multiplier, strategy.max_risk_multiplier);
  const entryPrice = applyEntrySlippage(signal.side, signal.trigger_price);
  const riskAmount = Number((context.baseRiskAmount * riskMultiplier).toFixed(4));

  if (strategy.lifecycle_status === "shadow") {
    return { action: "shadow", entryPrice, riskAmount };
  }

  if (!isPaperLive(strategy.lifecycle_status)) {
    return { action: "reject", reason: "unsupported strategy lifecycle" };
  }

  if (!context.tradingEnabled) return { action: "reject", reason: "trading disabled" };
  if (context.openPositionCount >= context.maxConcurrentPositions) return { action: "reject", reason: "max concurrent positions reached" };
  if (context.tradesTodayCount >= context.maxTradesPerDay) return { action: "reject", reason: "max daily trades reached" };
  if (context.hasDuplicateForInstrumentToday) return { action: "reject", reason: "duplicate instrument for strategy today" };

  const shares = calculateShares(context.baseRiskAmount, riskMultiplier, entryPrice, signal.stop_loss_price);
  if (shares <= 0) return { action: "reject", reason: "position size is zero" };

  return {
    action: "paper_trade",
    entryPrice,
    stopLossPrice: signal.stop_loss_price,
    targetPrice: signal.target_price,
    shares,
    riskAmount,
    entrySlippagePct: 0.05,
  };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
deno test supabase/functions/bot-signal-executor/executor.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/bot-signal-executor/executor.ts supabase/functions/bot-signal-executor/executor.test.ts
git commit -m "RALPH: add signal executor decision logic"
```

---

### Task 3: Edge Handler for `bot-signal-executor`

**Files:**
- Create: `supabase/functions/bot-signal-executor/index.ts`

- [ ] **Step 1: Implement handler**

Create `supabase/functions/bot-signal-executor/index.ts`:

```ts
import { createServiceClient } from "../_shared/supabase.ts";
import { getMarketSessionStatus, marketClosedResponse } from "../_shared/market-hours.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import { buildExecutorDecision, type ExecutorContext, type SignalRow, type StrategyRow } from "./executor.ts";

const BASE_RISK_AMOUNT = 1000;
const MAX_CONCURRENT_POSITIONS = 2;
const MAX_TRADES_PER_DAY = 6;
const SIGNAL_LIMIT = 25;

function istDateStr(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

Deno.serve(async () => {
  const now = new Date();
  const session = getMarketSessionStatus(now);
  if (!session.isOpen) return marketClosedResponse(now);

  const supabase = createServiceClient();
  const todayIst = istDateStr(now);

  const { data: settings, error: settingsError } = await supabase
    .from("bot_settings")
    .select("trading_enabled")
    .eq("id", 1)
    .maybeSingle();

  if (settingsError) return Response.json({ error: settingsError.message }, { status: 500 });

  const { count: openPositionCount } = await supabase
    .from("bot_paper_trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");

  const { count: tradesTodayCount } = await supabase
    .from("bot_paper_trades")
    .select("id", { count: "exact", head: true })
    .gte("entry_time", `${todayIst}T00:00:00Z`)
    .lt("entry_time", `${todayIst}T23:59:59Z`);

  const { data: signals, error: signalError } = await supabase
    .from("bot_trade_signals")
    .select("id,strategy_id,instrument_id,source,side,trigger_price,stop_loss_price,target_price,signal_time,metadata")
    .eq("status", "pending")
    .order("signal_time", { ascending: true })
    .limit(SIGNAL_LIMIT);

  if (signalError) return Response.json({ error: signalError.message }, { status: 500 });

  let accepted = 0;
  let rejected = 0;
  let shadowTracked = 0;

  for (const signal of (signals ?? []) as SignalRow[]) {
    const { data: strategy } = await supabase
      .from("bot_strategies")
      .select("id,name,enabled,lifecycle_status,risk_multiplier,max_risk_multiplier")
      .eq("id", signal.strategy_id)
      .maybeSingle();

    if (!strategy) {
      await supabase.from("bot_trade_signals").update({
        status: "rejected",
        rejection_reason: "strategy not found",
        processed_at: now.toISOString(),
      }).eq("id", signal.id);
      rejected++;
      continue;
    }

    const { data: latestCandle } = await supabase
      .from("bot_candles")
      .select("close")
      .eq("instrument_id", signal.instrument_id)
      .eq("timeframe", "1m")
      .order("candle_open_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { count: duplicateCount } = await supabase
      .from("bot_paper_trades")
      .select("id", { count: "exact", head: true })
      .eq("strategy_id", signal.strategy_id)
      .eq("instrument_id", signal.instrument_id)
      .gte("entry_time", `${todayIst}T00:00:00Z`)
      .lt("entry_time", `${todayIst}T23:59:59Z`);

    const context: ExecutorContext = {
      tradingEnabled: settings?.trading_enabled ?? false,
      baseRiskAmount: BASE_RISK_AMOUNT,
      maxConcurrentPositions: MAX_CONCURRENT_POSITIONS,
      maxTradesPerDay: MAX_TRADES_PER_DAY,
      openPositionCount: openPositionCount ?? 0,
      tradesTodayCount: tradesTodayCount ?? 0,
      hasDuplicateForInstrumentToday: (duplicateCount ?? 0) > 0,
      latestPrice: latestCandle?.close ? Number(latestCandle.close) : null,
      nowIso: now.toISOString(),
    };

    const decision = buildExecutorDecision(signal, strategy as StrategyRow, context);

    if (decision.action === "reject") {
      await supabase.from("bot_trade_signals").update({
        status: "rejected",
        rejection_reason: decision.reason,
        processed_at: now.toISOString(),
      }).eq("id", signal.id);
      rejected++;
      continue;
    }

    if (decision.action === "shadow") {
      await supabase.from("bot_signal_outcomes").insert({
        signal_id: signal.id,
        mode: "shadow",
        entry_price: decision.entryPrice,
        status: "open",
        opened_at: now.toISOString(),
      });
      await supabase.from("bot_trade_signals").update({
        status: "shadow_tracked",
        processed_at: now.toISOString(),
      }).eq("id", signal.id);
      shadowTracked++;
      continue;
    }

    const { data: trade, error: tradeError } = await supabase
      .from("bot_paper_trades")
      .insert({
        strategy_id: signal.strategy_id,
        instrument_id: signal.instrument_id,
        side: signal.side,
        entry_price: decision.entryPrice,
        entry_time: now.toISOString(),
        entry_slippage_pct: decision.entrySlippagePct,
        stop_loss_price: decision.stopLossPrice,
        target_price: decision.targetPrice,
        shares: decision.shares,
        status: "open",
        risk_amount: decision.riskAmount,
      })
      .select("id")
      .single();

    if (tradeError || !trade) {
      await supabase.from("bot_trade_signals").update({
        status: "rejected",
        rejection_reason: tradeError?.message ?? "trade insert failed",
        processed_at: now.toISOString(),
      }).eq("id", signal.id);
      rejected++;
      continue;
    }

    await supabase.from("bot_signal_outcomes").insert({
      signal_id: signal.id,
      paper_trade_id: trade.id,
      mode: "paper_live",
      entry_price: decision.entryPrice,
      status: "open",
      opened_at: now.toISOString(),
    });

    await supabase.from("bot_trade_signals").update({
      status: "accepted",
      processed_at: now.toISOString(),
    }).eq("id", signal.id);

    await sendTelegramNotification({
      type: "entry",
      symbol: signal.source,
      side: signal.side,
      entryPrice: decision.entryPrice,
      targetPrice: decision.targetPrice,
      stopLossPrice: decision.stopLossPrice,
      riskAmount: decision.riskAmount,
      shares: decision.shares,
      timestamp: now.toISOString(),
    });

    accepted++;
  }

  return Response.json({ ok: true, accepted, rejected, shadow_tracked: shadowTracked });
});
```

- [ ] **Step 2: Run executor tests**

Run:

```bash
deno test supabase/functions/bot-signal-executor
```

Expected: pure executor tests pass. Handler has no network tests.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/bot-signal-executor/index.ts
git commit -m "RALPH: add signal executor edge function"
```

---

### Task 4: Refactor ORB Scanner to Enqueue Signals

**Files:**
- Modify: `supabase/functions/orb-scanner/index.ts`
- Test: `supabase/functions/orb-scanner/orb-scanner.test.ts`

- [ ] **Step 1: Update ORB scanner behavior**

In `supabase/functions/orb-scanner/index.ts`, replace both direct `bot_paper_trades` insert blocks with `bot_trade_signals` inserts.

For long signals, insert:

```ts
const { error } = await supabase.from("bot_trade_signals").insert({
  strategy_id: strategyUuid,
  source: "orb_breakout",
  instrument_id: inst.id,
  side: "long",
  signal_time: now.toISOString(),
  trigger_price: latestClose,
  stop_loss_price: stopPrice,
  target_price: targetPrice,
  timeframe: "1m",
  metadata: {
    symbol: inst.symbol,
    name: inst.name,
    or_high: inst.or_high,
    or_low: inst.or_low,
    or_range: orRange,
    breakout_buffer: BREAKOUT_BUFFER,
  },
});
```

For short signals, insert the same shape with `side: "short"`.

Rename `tradesPlaced` response fields to `signals_enqueued` while preserving `trades_placed` as `0` for backward-compatible logs:

```ts
return Response.json({
  status: "Breakout detection",
  signals_enqueued: signalsEnqueued,
  trades_placed: 0,
});
```

- [ ] **Step 2: Add/adjust ORB tests**

In `supabase/functions/orb-scanner/orb-scanner.test.ts`, add a pure expectation test if existing tests are currently structural. The expected long signal payload should contain:

```ts
{
  source: "orb_breakout",
  side: "long",
  trigger_price: 101,
  stop_loss_price: 95,
  target_price: 110,
  timeframe: "1m",
}
```

The test should assert the ORB scanner no longer builds `bot_paper_trades` insert payloads.

- [ ] **Step 3: Run ORB tests**

Run:

```bash
deno test supabase/functions/orb-scanner/orb-scanner.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/orb-scanner/index.ts supabase/functions/orb-scanner/orb-scanner.test.ts
git commit -m "RALPH: enqueue orb signals for executor"
```

---

### Task 5: Outcome Updates on Exits and EOD

**Files:**
- Modify: `supabase/functions/check-exits/index.ts`
- Modify: `supabase/functions/eod-flatten/index.ts`
- Test: `supabase/functions/check-exits/check-exits.test.ts`
- Test: `supabase/functions/eod-flatten/eod-flatten.test.ts`

- [ ] **Step 1: Fix stop/target slippage direction in `check-exits`**

Use this helper in `check-exits/index.ts`:

```ts
function applyExitSlippage(side: "long" | "short", exitPrice: number, exitReason: string): number {
  const slippageRate = exitReason === "stop" ? 0.0010 : 0.0005;
  const raw = side === "long"
    ? exitPrice * (1 - slippageRate)
    : exitPrice * (1 + slippageRate);
  return Number(raw.toFixed(4));
}
```

Replace the existing exit slippage calculation with:

```ts
const exitPriceWithSlippage = applyExitSlippage(trade.side, exitPrice, exitReason);
```

- [ ] **Step 2: Update linked live paper outcome after each closed trade**

After a successful trade update in `check-exits/index.ts`, add:

```ts
const openedAt = new Date(trade.entry_time ?? candle.candle_open_at).getTime();
const closedAt = new Date(candle.candle_open_at).getTime();
const durationMinutes = Number.isFinite(openedAt) && Number.isFinite(closedAt)
  ? Math.max(0, Math.floor((closedAt - openedAt) / 60_000))
  : null;
const rMultiple = trade.risk_amount && trade.risk_amount > 0
  ? netPnl / trade.risk_amount
  : null;

await supabase
  .from("bot_signal_outcomes")
  .update({
    exit_price: exitPriceWithSlippage,
    exit_reason: exitReason,
    gross_pnl: grossPnl,
    net_pnl: netPnl,
    r_multiple: rMultiple,
    duration_minutes: durationMinutes,
    status: "closed",
    closed_at: candle.candle_open_at,
  })
  .eq("paper_trade_id", trade.id)
  .eq("status", "open");
```

Also include `entry_time` in the `bot_paper_trades` select list.

- [ ] **Step 3: Update linked outcome in `eod-flatten`**

After each successful EOD close, add the same `bot_signal_outcomes` update using:

```ts
exit_reason: "eod",
closed_at: now.toISOString(),
```

Use `netPnl / trade.risk_amount` when risk is positive.

- [ ] **Step 4: Switch EOD circuit breaker from `bot_config` to `bot_settings`**

Replace:

```ts
await supabase
  .from("bot_config")
  .update({ trading_enabled: false, circuit_breaker_triggered_at: now.toISOString() })
  .eq("id", 1);
```

With:

```ts
await supabase
  .from("bot_settings")
  .update({
    trading_enabled: false,
    kill_switch_reason: `Daily loss ${totalNet.toFixed(0)} exceeded 3000 limit`,
  })
  .eq("id", 1);
```

- [ ] **Step 5: Run exit/EOD tests**

Run:

```bash
deno test supabase/functions/check-exits/check-exits.test.ts supabase/functions/eod-flatten/eod-flatten.test.ts
```

Expected: pass. If existing tests assumed old long stop slippage behavior, update expectations so long stop exits are lower than stop price and short stop exits are higher than stop price.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/check-exits/index.ts supabase/functions/check-exits/check-exits.test.ts supabase/functions/eod-flatten/index.ts supabase/functions/eod-flatten/eod-flatten.test.ts
git commit -m "RALPH: update outcomes on paper trade exits"
```

---

### Task 6: Pure Feedback Logic

**Files:**
- Create: `supabase/functions/bot-feedback-run/feedback.ts`
- Test: `supabase/functions/bot-feedback-run/feedback.test.ts`

- [ ] **Step 1: Write failing tests**

Create `supabase/functions/bot-feedback-run/feedback.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateFeedbackMetrics,
  decideLifecycleTransition,
  type FeedbackOutcome,
  type FeedbackStrategy,
} from "./feedback.ts";

function outcomes(values: number[]): FeedbackOutcome[] {
  return values.map((netPnl, index) => ({
    net_pnl: netPnl,
    r_multiple: netPnl / 1000,
    status: "closed",
    created_at: `2026-06-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
  }));
}

const shadowStrategy: FeedbackStrategy = {
  id: "strategy-1",
  lifecycle_status: "shadow",
  risk_multiplier: 0.25,
  max_risk_multiplier: 1.5,
};

Deno.test("calculateFeedbackMetrics computes profit factor and win rate", () => {
  const metrics = calculateFeedbackMetrics(outcomes([100, 200, -100, -50]), 1);
  assertEquals(metrics.sampleCount, 4);
  assertEquals(metrics.profitFactor, 2);
  assertEquals(metrics.winRate, 0.5);
});

Deno.test("decideLifecycleTransition promotes shadow after 30 profitable outcomes", () => {
  const metrics = calculateFeedbackMetrics(outcomes([...Array(24).fill(100), ...Array(6).fill(-50)]), 0);
  const decision = decideLifecycleTransition(shadowStrategy, metrics);
  assertEquals(decision.newStatus, "paper_live_small");
  assertEquals(decision.decision, "promote");
});

Deno.test("decideLifecycleTransition keeps shadow when sample count is too low", () => {
  const metrics = calculateFeedbackMetrics(outcomes([...Array(10).fill(100)]), 0);
  const decision = decideLifecycleTransition(shadowStrategy, metrics);
  assertEquals(decision.newStatus, "shadow");
  assertEquals(decision.decision, "hold");
});

Deno.test("decideLifecycleTransition reduces weak live strategy", () => {
  const metrics = calculateFeedbackMetrics(outcomes([...Array(8).fill(100), ...Array(12).fill(-150)]), 0);
  const decision = decideLifecycleTransition(
    { ...shadowStrategy, lifecycle_status: "paper_live_normal", risk_multiplier: 1 },
    metrics,
  );
  assertEquals(decision.newStatus, "reduced");
  assertEquals(decision.newRiskMultiplier, 0.5);
});

Deno.test("decideLifecycleTransition caps risk at 1.5", () => {
  const metrics = calculateFeedbackMetrics(outcomes([...Array(30).fill(200), ...Array(2).fill(-50)]), 0);
  const decision = decideLifecycleTransition(
    { ...shadowStrategy, lifecycle_status: "paper_live_small", risk_multiplier: 2, max_risk_multiplier: 2 },
    metrics,
  );
  assertEquals(decision.newRiskMultiplier, 1.5);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
deno test supabase/functions/bot-feedback-run/feedback.test.ts
```

Expected: failure because `feedback.ts` does not exist.

- [ ] **Step 3: Implement feedback helpers**

Create `supabase/functions/bot-feedback-run/feedback.ts`:

```ts
export type LifecycleStatus = "research" | "shadow" | "paper_live_small" | "paper_live_normal" | "reduced" | "disabled";

export type FeedbackOutcome = {
  net_pnl: number | null;
  r_multiple: number | null;
  status: string;
  created_at: string;
};

export type FeedbackStrategy = {
  id: string;
  lifecycle_status: LifecycleStatus;
  risk_multiplier: number;
  max_risk_multiplier: number;
};

export type FeedbackMetrics = {
  sampleCount: number;
  profitFactor: number | null;
  winRate: number | null;
  averageR: number | null;
  maxDrawdown: number;
  rejectionRate: number;
};

export type LifecycleDecision = {
  decision: "promote" | "reduce" | "disable" | "hold";
  newStatus: LifecycleStatus;
  newRiskMultiplier: number;
  rationale: string;
};

const MAX_RISK_MULTIPLIER = 1.5;

function capRisk(value: number, maxRisk: number): number {
  return Math.min(Math.max(value, 0), maxRisk, MAX_RISK_MULTIPLIER);
}

export function calculateFeedbackMetrics(outcomes: FeedbackOutcome[], rejectedSignals: number): FeedbackMetrics {
  const closed = outcomes.filter((outcome) => outcome.status === "closed" && outcome.net_pnl !== null);
  const wins = closed.filter((outcome) => (outcome.net_pnl ?? 0) > 0);
  const losses = closed.filter((outcome) => (outcome.net_pnl ?? 0) < 0);
  const grossWins = wins.reduce((sum, outcome) => sum + (outcome.net_pnl ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((sum, outcome) => sum + (outcome.net_pnl ?? 0), 0));
  const rValues = closed.map((outcome) => outcome.r_multiple).filter((value): value is number => value !== null);

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const outcome of closed) {
    equity += outcome.net_pnl ?? 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }

  const totalSignals = closed.length + rejectedSignals;

  return {
    sampleCount: closed.length,
    profitFactor: grossLosses === 0 ? (grossWins > 0 ? Number.POSITIVE_INFINITY : null) : grossWins / grossLosses,
    winRate: closed.length > 0 ? wins.length / closed.length : null,
    averageR: rValues.length > 0 ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
    maxDrawdown,
    rejectionRate: totalSignals > 0 ? rejectedSignals / totalSignals : 0,
  };
}

export function decideLifecycleTransition(
  strategy: FeedbackStrategy,
  metrics: FeedbackMetrics,
): LifecycleDecision {
  const currentRisk = capRisk(strategy.risk_multiplier, strategy.max_risk_multiplier);
  const profitFactor = metrics.profitFactor ?? 0;
  const averageR = metrics.averageR ?? 0;

  if (metrics.rejectionRate >= 0.5 && metrics.sampleCount >= 10) {
    return {
      decision: "disable",
      newStatus: "disabled",
      newRiskMultiplier: 0,
      rationale: `Disabled because rejection rate ${(metrics.rejectionRate * 100).toFixed(1)}% is too high.`,
    };
  }

  if (
    (strategy.lifecycle_status === "paper_live_small" || strategy.lifecycle_status === "paper_live_normal") &&
    metrics.sampleCount >= 10 &&
    profitFactor < 1.0
  ) {
    const newRisk = capRisk(currentRisk * 0.5, strategy.max_risk_multiplier);
    return {
      decision: "reduce",
      newStatus: "reduced",
      newRiskMultiplier: newRisk,
      rationale: `Reduced because rolling profit factor ${profitFactor.toFixed(2)} is below 1.00.`,
    };
  }

  if (strategy.lifecycle_status === "shadow") {
    if (metrics.sampleCount >= 30 && profitFactor >= 1.1 && averageR > 0) {
      return {
        decision: "promote",
        newStatus: "paper_live_small",
        newRiskMultiplier: capRisk(0.25, strategy.max_risk_multiplier),
        rationale: `Promoted from shadow after ${metrics.sampleCount} outcomes with profit factor ${profitFactor.toFixed(2)}.`,
      };
    }
    return {
      decision: "hold",
      newStatus: "shadow",
      newRiskMultiplier: currentRisk,
      rationale: `Held in shadow with ${metrics.sampleCount} outcomes and profit factor ${profitFactor.toFixed(2)}.`,
    };
  }

  if (strategy.lifecycle_status === "paper_live_small") {
    if (metrics.sampleCount >= 30 && profitFactor >= 1.2 && averageR > 0) {
      return {
        decision: "promote",
        newStatus: "paper_live_normal",
        newRiskMultiplier: capRisk(Math.max(currentRisk, 1.0), strategy.max_risk_multiplier),
        rationale: `Promoted to normal paper risk after ${metrics.sampleCount} live outcomes with profit factor ${profitFactor.toFixed(2)}.`,
      };
    }
  }

  return {
    decision: "hold",
    newStatus: strategy.lifecycle_status,
    newRiskMultiplier: currentRisk,
    rationale: `Held ${strategy.lifecycle_status} with ${metrics.sampleCount} outcomes.`,
  };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
deno test supabase/functions/bot-feedback-run/feedback.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/bot-feedback-run/feedback.ts supabase/functions/bot-feedback-run/feedback.test.ts
git commit -m "RALPH: add strategy feedback decisions"
```

---

### Task 7: Edge Handler for `bot-feedback-run`

**Files:**
- Create: `supabase/functions/bot-feedback-run/index.ts`

- [ ] **Step 1: Implement feedback handler**

Create `supabase/functions/bot-feedback-run/index.ts`:

```ts
import { createServiceClient } from "../_shared/supabase.ts";
import { sendTelegramNotification } from "../_shared/telegram.ts";
import {
  calculateFeedbackMetrics,
  decideLifecycleTransition,
  type FeedbackOutcome,
  type FeedbackStrategy,
} from "./feedback.ts";

const REVIEW_DAYS = 30;

Deno.serve(async () => {
  const supabase = createServiceClient();
  const now = new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - REVIEW_DAYS * 86_400_000).toISOString();

  const { data: strategies, error: strategyError } = await supabase
    .from("bot_strategies")
    .select("id,name,lifecycle_status,risk_multiplier,max_risk_multiplier,enabled")
    .eq("enabled", true);

  if (strategyError) return Response.json({ error: strategyError.message }, { status: 500 });

  let reviewed = 0;
  let changed = 0;

  for (const strategy of strategies ?? []) {
    const { data: outcomes } = await supabase
      .from("bot_signal_outcomes")
      .select("net_pnl,r_multiple,status,created_at,bot_trade_signals!inner(strategy_id)")
      .eq("bot_trade_signals.strategy_id", strategy.id)
      .gte("created_at", windowStart)
      .lt("created_at", windowEnd);

    const { count: rejectedSignals } = await supabase
      .from("bot_trade_signals")
      .select("id", { count: "exact", head: true })
      .eq("strategy_id", strategy.id)
      .eq("status", "rejected")
      .gte("created_at", windowStart)
      .lt("created_at", windowEnd);

    const metrics = calculateFeedbackMetrics((outcomes ?? []) as FeedbackOutcome[], rejectedSignals ?? 0);
    const decision = decideLifecycleTransition(strategy as FeedbackStrategy, metrics);

    await supabase.from("bot_strategy_reviews").insert({
      strategy_id: strategy.id,
      window_start: windowStart,
      window_end: windowEnd,
      sample_count: metrics.sampleCount,
      profit_factor: Number.isFinite(metrics.profitFactor ?? NaN) ? metrics.profitFactor : null,
      win_rate: metrics.winRate,
      average_r: metrics.averageR,
      max_drawdown: metrics.maxDrawdown,
      rejection_rate: metrics.rejectionRate,
      previous_status: strategy.lifecycle_status,
      new_status: decision.newStatus,
      previous_risk_multiplier: strategy.risk_multiplier,
      new_risk_multiplier: decision.newRiskMultiplier,
      decision: decision.decision,
      rationale: decision.rationale,
      metrics: {
        sample_count: metrics.sampleCount,
        profit_factor: metrics.profitFactor,
        win_rate: metrics.winRate,
        average_r: metrics.averageR,
        max_drawdown: metrics.maxDrawdown,
        rejection_rate: metrics.rejectionRate,
      },
    });

    reviewed++;

    if (
      decision.newStatus !== strategy.lifecycle_status ||
      decision.newRiskMultiplier !== Number(strategy.risk_multiplier)
    ) {
      await supabase
        .from("bot_strategies")
        .update({
          lifecycle_status: decision.newStatus,
          risk_multiplier: decision.newRiskMultiplier,
          last_reviewed_at: windowEnd,
        })
        .eq("id", strategy.id);

      await sendTelegramNotification({
        type: "heartbeat",
        symbol: "BOT",
        timestamp: windowEnd,
        message: `Strategy ${strategy.name} ${decision.decision}: ${decision.rationale}`,
      });

      changed++;
    } else {
      await supabase
        .from("bot_strategies")
        .update({ last_reviewed_at: windowEnd })
        .eq("id", strategy.id);
    }
  }

  return Response.json({ ok: true, reviewed, changed, window_start: windowStart, window_end: windowEnd });
});
```

- [ ] **Step 2: Run feedback tests**

Run:

```bash
deno test supabase/functions/bot-feedback-run
```

Expected: pure feedback tests pass. Handler has no network tests.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/bot-feedback-run/index.ts
git commit -m "RALPH: add strategy feedback edge function"
```

---

### Task 8: Full Verification

**Files:**
- No new files unless verification reveals a defect.

- [ ] **Step 1: Run Deno tests for changed Supabase functions**

Run:

```bash
deno test \
  supabase/functions/bot-signal-executor \
  supabase/functions/bot-feedback-run \
  supabase/functions/orb-scanner/orb-scanner.test.ts \
  supabase/functions/check-exits/check-exits.test.ts \
  supabase/functions/eod-flatten/eod-flatten.test.ts \
  supabase/functions/_shared/market-hours.test.ts \
  supabase/functions/_shared/telegram.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run bot frontend tests to prove options dashboard was not affected**

Run:

```bash
cd bot && pnpm test
```

Expected: all existing `bot/src/lib` tests pass.

- [ ] **Step 3: Run TypeScript check for the options dashboard**

Run:

```bash
cd bot && pnpm typecheck
```

Expected: pass. This is a regression check only; no dashboard files should be modified.

- [ ] **Step 4: Inspect git diff for scope leaks**

Run:

```bash
git diff --name-only HEAD
```

Expected changed paths are limited to:

```text
supabase/migrations/20260605120000_bot_strategy_promotion_engine.sql
supabase/functions/bot-signal-executor/*
supabase/functions/bot-feedback-run/*
supabase/functions/orb-scanner/*
supabase/functions/check-exits/*
supabase/functions/eod-flatten/*
docs/superpowers/plans/2026-06-05-automatic-strategy-promotion-engine.md
```

No `bot/src/components` or `bot/src/app` dashboard files should appear.

- [ ] **Step 5: Commit final verification fixes if any**

If verification required fixes, commit them:

```bash
git add <fixed-files>
git commit -m "RALPH: verify automatic strategy promotion engine"
```

If no fixes were needed, do not create an empty commit.

