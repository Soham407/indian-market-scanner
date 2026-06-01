# Options Dashboard Chart Toggle And Plot Clipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show one selectable options chart at a time and constrain SVG series colors to the plot rectangle.

**Architecture:** Add small pure UI helpers for the selected chart mode and plot clip geometry so behavior can be covered by Vitest. Use the helpers from the page and both existing SVG chart components without changing the Supabase data pipeline.

**Tech Stack:** Next.js 16, React 19, TypeScript, TailwindCSS, inline SVG, Vitest

---

### Task 1: Add Tested Chart Selection And Plot Geometry Helpers

**Files:**
- Create: `bot/src/lib/options-chart-ui.ts`
- Create: `bot/src/lib/options-chart-ui.test.ts`

- [ ] **Step 1: Write failing tests**

Assert that ATM is the default mode, only the selected chart is visible, and the plot rectangle matches the existing SVG margins.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd bot && ./node_modules/.bin/vitest run src/lib/options-chart-ui.test.ts`

Expected: FAIL because `options-chart-ui.ts` does not exist.

- [ ] **Step 3: Add minimal helpers**

Export `DEFAULT_OPTIONS_CHART_MODE`, `getOptionsChartVisibility`, and `getPremiumDecayPlotClipRect`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd bot && ./node_modules/.bin/vitest run src/lib/options-chart-ui.test.ts`

Expected: PASS.

### Task 2: Render One Selected Chart

**Files:**
- Modify: `bot/src/app/page.tsx`

- [ ] **Step 1: Add page state and selector buttons**

Use `DEFAULT_OPTIONS_CHART_MODE` for initial state and `getOptionsChartVisibility` for conditional rendering.

- [ ] **Step 2: Render only the selected chart**

Replace the two-column grid with one full-width chart slot.

### Task 3: Clip Both SVG Plot Groups

**Files:**
- Modify: `bot/src/components/premium-decay-chart.tsx`
- Modify: `bot/src/components/band-average-chart.tsx`

- [ ] **Step 1: Add SVG clip paths**

Use `getPremiumDecayPlotClipRect` to define a plot rectangle inside each chart's `<defs>`.

- [ ] **Step 2: Clip series rendering**

Wrap CE/PE area and line paths in a clipped SVG group while leaving labels and tooltips outside it.

### Task 4: Verify

- [ ] **Step 1: Run automated checks**

Run:

```bash
cd bot
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit
pnpm build
cd ..
git diff --check
```

- [ ] **Step 2: Inspect in browser**

Open `http://localhost:3000`, confirm only one chart renders, switch to `Band average`, and visually confirm fills stay within the plot rectangle.
