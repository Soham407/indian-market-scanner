# Full-Session Premium Decay Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain the full NSE options session and expose it through a readable horizontal chart scrollbar.

**Architecture:** Extend the existing pure options-chart UI helper with session retention constants and a dynamic SVG width calculation. Both chart components consume those helpers, render a wider SVG inside an overflow container, and position the scroll wrapper at the newest samples on mount.

**Tech Stack:** Next.js 16, React 19, TypeScript, TailwindCSS, inline SVG, Vitest

---

### Task 1: Add Tested Session Layout Helpers

**Files:**
- Modify: `bot/src/lib/options-chart-ui.ts`
- Modify: `bot/src/lib/options-chart-ui.test.ts`

- [ ] **Step 1: Write failing tests**

Assert that ATM retains 376 one-minute samples, the band retains 4,136 rows, and a 376-minute session receives a wider SVG than the 1,000-pixel viewport canvas.

- [ ] **Step 2: Run the focused test**

Run: `cd bot && ./node_modules/.bin/vitest run src/lib/options-chart-ui.test.ts`

Expected: FAIL because the new helper exports do not exist.

- [ ] **Step 3: Add minimal helpers**

Export `NSE_SESSION_MINUTE_COUNT`, `NSE_BAND_ROW_LIMIT`, and `getPremiumDecaySvgWidth`.

- [ ] **Step 4: Run the focused test**

Run: `cd bot && ./node_modules/.bin/vitest run src/lib/options-chart-ui.test.ts`

Expected: PASS.

### Task 2: Add ATM Horizontal Scrolling

**Files:**
- Modify: `bot/src/components/premium-decay-chart.tsx`

- [ ] **Step 1: Retain the full ATM session**

Use `NSE_SESSION_MINUTE_COUNT` as the default query and realtime retention limit.

- [ ] **Step 2: Render a wider SVG in an overflow wrapper**

Calculate the SVG width from the minute-slot count, update geometry to use that width, and scroll the wrapper to its right edge on mount.

### Task 3: Add Band-Average Horizontal Scrolling

**Files:**
- Modify: `bot/src/components/band-average-chart.tsx`

- [ ] **Step 1: Retain the full band session**

Use `NSE_BAND_ROW_LIMIT` for query and realtime retention.

- [ ] **Step 2: Render a wider SVG in an overflow wrapper**

Apply the same dynamic geometry and latest-sample scroll positioning as the ATM chart.

### Task 4: Verify

- [ ] **Step 1: Run automated checks**

```bash
cd bot
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit
pnpm build
cd ..
git diff --check
```

- [ ] **Step 2: Inspect both charts**

Open `http://localhost:3000`, confirm a horizontal scrollbar exists, confirm the viewport opens at the latest samples, and scroll backward toward 9:15 am in ATM and band-average modes.
