# Cost-Aware Selective Trading Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the paper bot net-positive by trading less (quality score + caps), pricing in costs (economics gate), fixing exit geometry (ATR stops, breakeven, time-stop), filtering by NIFTY regime, and alerting when the pipeline silently dies.

**Architecture:** All pure decision logic goes in `supabase/functions/_shared/trade-math.ts` with Deno tests (mirroring the existing `bot-signal-executor/executor.ts` + `executor.test.ts` pattern). Edge functions only wire data in/out. orb-scanner stops placing trades directly and becomes a signal generator, so **every** trade flows through bot-signal-executor's gates. Spec: `docs/superpowers/specs/2026-06-10-cost-aware-selective-engine-design.md`.

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), Postgres migrations, `deno test` for unit tests.

**Key facts for someone with zero context:**
- `bot_trade_signals.status`: `pending` → executor picks up; `shadow_tracked` = tracked but not traded; `rejected`.
- Executor decision logic is the pure function `buildExecutorDecision(signal, strategy, context)` in `bot-signal-executor/executor.ts`.
- NIFTY spot per minute lives in `bot_premium_decay_points.underlying_ltp` (options dashboard table — READ ONLY, never modify/delete).
- Charges model: ₹20/leg brokerage (₹40 round trip) + 0.05% statutory on exit value.
- Run tests: `deno test supabase/functions/` from repo root.
- Deploy: `supabase functions deploy <name>`. Apply migrations live via Supabase management API (see Task 8).

---

### Task 1: Migration — schema + caps + promotion gates

**Files:**
- Create: `supabase/migrations/20260611090000_selective_engine.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Cost-aware selective engine (spec 2026-06-10).

-- Breakeven tracking on open trades
alter table public.bot_paper_trades
  add column if not exists stop_moved_to_breakeven boolean not null default false;

-- Allow the new time_stop exit reason on both tables that constrain exit_reason
do $$
declare r record;
begin
  for r in
    select conrelid::regclass::text as tbl, conname
    from pg_constraint
    where conname like '%exit_reason%' and contype = 'c'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table public.bot_paper_trades
  add constraint bot_paper_trades_exit_reason_check
  check (exit_reason is null or exit_reason in ('stop','target','eod','time_stop'));

alter table public.bot_signal_outcomes
  add constraint bot_signal_outcomes_exit_reason_check
  check (exit_reason is null or exit_reason in ('stop','target','eod','time_stop'));

-- NIFTY opening range cache + watchdog dedup
alter table public.bot_settings
  add column if not exists nifty_or_high numeric,
  add column if not exists nifty_or_low numeric,
  add column if not exists nifty_or_date date,
  add column if not exists watchdog_alerted_date date;

-- Hard selectivity caps (constraint requires >0, so 5/3 are valid)
update public.bot_settings
set max_daily_trades = 5, max_concurrent_positions = 3
where id = 1;

-- Real-money promotion gates: documentation-as-config on every strategy
update public.bot_strategies
set promotion_thresholds = promotion_thresholds || '{
  "real_money_min_trades": 60,
  "real_money_min_profit_factor": 1.3,
  "real_money_max_drawdown_pct": 5,
  "real_money_min_weeks": 4
}'::jsonb;
```

- [ ] **Step 2: Sanity check the SQL locally** — `grep -c "add column" supabase/migrations/20260611090000_selective_engine.sql` → expect 6.
- [ ] **Step 3: Commit** — `git add supabase/migrations/20260611090000_selective_engine.sql && git commit -m "feat(db): selective engine schema — breakeven flag, time_stop reason, nifty OR cache, caps 5/3"`

---

### Task 2: Pure logic — `_shared/trade-math.ts` (TDD)

**Files:**
- Create: `supabase/functions/_shared/trade-math.ts`
- Create: `supabase/functions/_shared/trade-math.test.ts`

Functions (exact signatures — later tasks import these):

```typescript
export type Candle1m = { high: number; low: number; close: number };

// ATR(14) over 5-min bars aggregated from 1-min candles (oldest→newest input).
// Returns null when fewer than 15 five-min bars are available.
export function atrFrom1mCandles(candles: Candle1m[]): number | null;

// Stop distance = 1.0×ATR clamped to [0.4%, 1.5%] of price; target = 1.5×stop.
export function stopTargetFromAtr(
  side: "long" | "short", entryPrice: number, atr: number | null,
): { stopLossPrice: number; targetPrice: number };

// 0–100 quality score per spec §1.
export function scoreSignal(input: {
  volumeMultiplier: number;          // session pace vs prev-day pace (volumeStats)
  orRangePct: number | null;         // (or_high-or_low)/price, null when N/A
  stockMovePct: number;              // (last - vwap)/vwap
  niftyMovePct: number | null;       // (spot - OR mid)/OR mid, null when stale
  side: "long" | "short";
  minutesSinceOpenIst: number;
}): { score: number; components: Record<string, number> };

// Spec §2. Returns { accept: true } or { accept: false, reason: string }.
export function economicsGate(input: {
  side: "long" | "short"; entryPrice: number; stopLossPrice: number;
  targetPrice: number; shares: number; winRate: number;  // 0..1
}): { accept: boolean; reason?: string };

// Spec §4. Abstains (returns true) when niftySpot or OR is null/stale.
export function niftyRegimeAllows(
  side: "long" | "short",
  niftySpot: number | null,
  orHigh: number | null,
  orLow: number | null,
): boolean;

// Spec §3 exits. R = riskAmount (₹). unrealizedGross in ₹.
export function shouldMoveToBreakeven(unrealizedGross: number, riskAmount: number, alreadyMoved: boolean): boolean;
export function shouldTimeStop(ageMinutes: number, unrealizedGross: number, riskAmount: number): boolean;
```

Scoring weights: volume `min(40, round(volumeMultiplier * 13.3))`; OR-range 20 when `0.3% ≤ orRangePct ≤ 5%` else 0 (10 when null); relative strength `min(25, max(0, round(alignedDiffPct * 12.5)))` where `alignedDiffPct = side==long ? (stockMovePct−niftyMovePct)*100 : (niftyMovePct−stockMovePct)*100` (12 when niftyMovePct null); time-of-day 15 before 105 min since open (11:00 IST), linearly down to 0 at 225 min (13:00 IST).

Economics: `charges = 40 + 0.0005 * exitValue` where `exitValue = targetPrice*shares`; `EV = p*targetDist*shares − (1−p)*stopDist*shares − charges`; reject "economics: negative EV" when `EV ≤ 0`; reject "economics: charges exceed 10% of expected win" when `charges > 0.10 * targetDist * shares`.

- [ ] **Step 1: Write `trade-math.test.ts`** — tests (use existing `executor.test.ts` style: `Deno.test` + `assertEquals` from `jsr:@std/assert` or whatever executor.test.ts imports — copy its import line):
  - `atrFrom1mCandles` returns null for <75 one-min candles; correct value for a constructed 80-candle series.
  - `stopTargetFromAtr` clamps: tiny ATR → 0.4% stop; huge ATR → 1.5%; target = 1.5× stop distance; correct direction per side.
  - `scoreSignal` 0 and 100 bounds; time decay after 11:00 IST; null nifty → neutral 12.
  - `economicsGate`: known-good case accepts; tiny target distance rejects on charges rule; low win rate rejects on EV.
  - `niftyRegimeAllows`: long blocked inside OR and below; allowed above OR-high; abstains on nulls.
  - breakeven/time-stop threshold edges (exactly 1R, exactly 60 min, exactly +0.5R).
- [ ] **Step 2: Run tests, verify they fail** — `deno test supabase/functions/_shared/trade-math.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `trade-math.ts`** per signatures above.
- [ ] **Step 4: Run tests, verify pass** — same command → all PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(bot): pure trade-math — ATR stops, quality score, economics gate, regime + exit rules"`

---

### Task 3: scan-alerts — score, ATR stops, NIFTY regime, threshold routing

**Files:**
- Modify: `supabase/functions/scan-alerts/index.ts` (`toBotSignal` ~line 338, `enqueueBotSignals` ~line 377, main handler ~line 445)

- [ ] **Step 1: NIFTY OR + spot helper.** Add `getNiftyRegime(supabase)`: read `bot_settings.nifty_or_high/low/or_date` (id=1); if `nifty_or_date != todayIst()`, compute from `bot_premium_decay_points`: `select min(underlying_ltp) lo, max(underlying_ltp) hi from bot_premium_decay_points where sampled_at >= '<today>T03:45:00Z' and sampled_at < '<today>T04:00:00Z'` (READ ONLY) and cache back to `bot_settings` with `nifty_or_date = today`. Spot = latest `underlying_ltp` within last 10 min (`order by sampled_at desc limit 1`); null when stale → filter abstains.
- [ ] **Step 2: In `enqueueBotSignals`, for each missing signal:** fetch last 80 one-min `bot_candles` for the instrument; `atrFrom1mCandles` → `stopTargetFromAtr(side, trigger_price, atr)` replaces the fixed ±1% stop and fallback target in `toBotSignal` (keep `take_profit_price` only if it is *farther* than the ATR target — never closer). Compute `scoreSignal` (volumeMultiplier from alert metadata, orRangePct from instrument when available, stockMovePct vs vwap, niftyMovePct from step 1, minutesSinceOpen()). Apply `niftyRegimeAllows` — when false, insert as `shadow_tracked` with `metadata.shadow_reason = 'nifty_regime'`.
- [ ] **Step 3: Threshold routing:** `status: score >= 60 ? 'pending' : 'shadow_tracked'`; always store `metadata.quality_score` and `metadata.score_components`. (Insert currently relies on the column default — set `status` explicitly now.)
- [ ] **Step 4: `deno check supabase/functions/scan-alerts/index.ts`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(scan-alerts): quality score routing, ATR stops, NIFTY regime filter"`

---

### Task 4: orb-scanner — convert to signal generator (single execution path)

**Files:**
- Modify: `supabase/functions/orb-scanner/index.ts` (Phase 2 breakout/trade-placement block)

- [ ] **Step 1:** Replace the direct `bot_paper_trades` insert block with a `bot_trade_signals` insert: `strategy_id` = orb_breakout strategy UUID (already resolved), `source = 'orb_scanner'`, trigger/stop/target from `stopTargetFromAtr` over the symbol's recent `bot_candles` (same pattern as Task 3 Step 2), `status` via the same `scoreSignal` ≥60 routing, dedupe via existing per-day signal key. Keep the OR-build phase (Phase 1) and circuit-breaker auto-reset untouched.
- [ ] **Step 2:** Apply `niftyRegimeAllows` the same way as scan-alerts (shared helper — export `getNiftyRegime` from `_shared/trade-math.ts`? No: DB access stays in functions; copy the small helper or put it in `_shared/nifty-regime.ts` used by both).
- [ ] **Step 3:** `deno check` clean; commit — `git commit -m "refactor(orb-scanner): emit signals through executor instead of placing trades directly"`

---

### Task 5: executor — economics gate (TDD on existing pattern)

**Files:**
- Modify: `supabase/functions/bot-signal-executor/executor.ts` (extend `ExecutorContext`, gate inside `buildExecutorDecision` after the duplicate check, before `calculateShares` — compute shares first, then gate)
- Modify: `supabase/functions/bot-signal-executor/executor.test.ts`
- Modify: `supabase/functions/bot-signal-executor/index.ts` (supply `strategyWinRate`; route economics rejections to `shadow_tracked` not `rejected`)

- [ ] **Step 1: Failing tests in `executor.test.ts`:** context gains `strategyWinRate: number | null`. Cases: profitable geometry accepts; sub-economic target rejects with reason starting `economics:`; `strategyWinRate: null` uses 0.40 fallback.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement: after shares are computed, call `economicsGate({...,winRate: context.strategyWinRate ?? 0.40, shares})`; on reject return `{ action: "shadow", ... }` variant carrying the reason (extend the shadow variant with `reason?: string`).
- [ ] **Step 4:** Run `deno test supabase/functions/bot-signal-executor/` → PASS (old tests updated for the new context field).
- [ ] **Step 5:** In `index.ts`, before the signal loop compute per-strategy win rate: `select net_pnl from bot_signal_outcomes where strategy_id = X and status='closed' order by closed_at desc limit 50`; winRate = wins/n when n ≥ 20 else null. Wire into context.
- [ ] **Step 6: Commit** — `git commit -m "feat(executor): cost-aware economics gate with live win rate"`

---

### Task 6: check-exits — breakeven + time-stop

**Files:**
- Modify: `supabase/functions/check-exits/index.ts` (inside the per-trade loop, after the stop/target checks)

- [ ] **Step 1:** Select `stop_moved_to_breakeven` in the open-trades query. After stop/target checks find no exit: compute `unrealizedGross = side==long ? (candle.close − entry)*shares : (entry − candle.close)*shares` and `ageMinutes` from `entry_time`. If `shouldMoveToBreakeven(unrealizedGross, risk_amount, stop_moved_to_breakeven)` → update `stop_loss_price = entry_price, stop_moved_to_breakeven = true` (no exit). Else if `shouldTimeStop(ageMinutes, unrealizedGross, risk_amount)` → exit at `candle.close` with target-grade slippage (0.05%), `exit_reason = 'time_stop'`, reusing the existing close/outcome/Telegram block (refactor that block into a local `closeTrade()` helper so stop/target/time_stop share it).
- [ ] **Step 2:** `deno check` clean. **Step 3: Commit** — `git commit -m "feat(check-exits): breakeven at +1R, time-stop for momentum-dead trades"`

---

### Task 7: bot-health-check — watchdog

**Files:**
- Modify: `supabase/functions/bot-health-check/index.ts`

- [ ] **Step 1:** After existing checks, when IST time ≥ 11:00 on a trading day AND `trading_enabled` AND `watchdog_alerted_date != today`: count today's `bot_paper_trades` (entry_time ≥ day start) and pending+shadow `bot_trade_signals` (signal_time ≥ day start), and check latest `bot_candles.candle_open_at` age. If trades==0 AND signals==0, OR candle age >10 min → Telegram `error` naming the dead stage (`candles stale` / `no signals generated` / `signals but no trades`), then set `watchdog_alerted_date = today`.
- [ ] **Step 2:** `deno check` clean. **Step 3: Commit** — `git commit -m "feat(health-check): silent-death watchdog with daily dedup"`

---

### Task 8: Apply live, deploy, verify, push

- [ ] **Step 1:** Apply Task 1 migration to live DB via management API (token from macOS keychain `Supabase CLI`, POST to `https://api.supabase.com/v1/projects/gykgrrjiqkucstcyrgxp/database/query` with the file as `{"query": ...}`).
- [ ] **Step 2:** Verify live: `bot_settings` shows caps 5/3 and new columns; `bot_paper_trades` has `stop_moved_to_breakeven`; constraint allows `time_stop`.
- [ ] **Step 3:** `supabase functions deploy scan-alerts orb-scanner bot-signal-executor check-exits bot-health-check`
- [ ] **Step 4:** Smoke: POST each deployed function with the cron's anon JWT → expect "Market closed" JSON (functions boot cleanly).
- [ ] **Step 5:** `deno test supabase/functions/` full pass; `git push`.
- [ ] **Step 6:** Next market open (9:15 IST): watch `bot_trade_signals` for `quality_score` in metadata, confirm ≤5 trades, confirm time-stops firing via Telegram.
