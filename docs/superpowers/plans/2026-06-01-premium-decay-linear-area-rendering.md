# Premium Decay Linear Area Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the premium-decay staircase SVG with straight connected one-minute CE and PE area paths matching the approved reference style.

**Architecture:** Keep the existing one-minute carry-forward series builder and live Supabase pipeline. Extract SVG line-path construction into the premium-decay library so linear rendering behavior is directly testable, then use it from the chart component for both lines and filled areas.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, inline SVG

---

### Task 1: Add Linear One-Minute Path Rendering

**Files:**
- Modify: `bot/src/lib/premium-decay.ts`
- Modify: `bot/src/lib/premium-decay.test.ts`
- Modify: `bot/src/components/premium-decay-chart.tsx`

- [ ] **Step 1: Write the failing test**

Add a test that calls:

```ts
buildLinearPremiumDecayPath(
  [
    { ceDecay: 0, chartPeDecay: 0 },
    { ceDecay: -3.9, chartPeDecay: 2.1 },
    { ceDecay: -1.2, chartPeDecay: 1.4 },
  ],
  "ceDecay",
  (index) => index * 10,
  (value) => 100 - value,
);
```

Assert that the returned SVG path is:

```ts
"M 0.00,100.00 L 10.00,103.90 L 20.00,101.20"
```

This proves adjacent minutes use one straight line command each and do not add horizontal staircase segments.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd bot
./node_modules/.bin/vitest run src/lib/premium-decay.test.ts
```

Expected: FAIL because `buildLinearPremiumDecayPath` is not exported.

- [ ] **Step 3: Add the minimal library helper**

Export a helper from `bot/src/lib/premium-decay.ts`:

```ts
export function buildLinearPremiumDecayPath(
  points: Pick<PremiumDecayPoint, "ceDecay" | "chartPeDecay">[],
  key: "ceDecay" | "chartPeDecay",
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
): string {
  return points.map((point, index) => {
    const command = index === 0 ? "M" : "L";
    return `${command} ${scaleX(index).toFixed(2)},${scaleY(point[key]).toFixed(2)}`;
  }).join(" ");
}
```

- [ ] **Step 4: Switch the component to linear paths**

Import `buildLinearPremiumDecayPath` in `bot/src/components/premium-decay-chart.tsx`.

Replace the staircase implementation in `buildLinePath` with:

```ts
return buildLinearPremiumDecayPath(
  slots,
  key,
  (index) => scaleX(index, slots.length, metrics),
  (value) => scaleY(value, metrics),
);
```

Keep `buildAreaPath` closing the line back to the zero baseline.

- [ ] **Step 5: Run frontend verification**

Run:

```bash
cd bot
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit
curl -fsS -o /tmp/indian-market-scanner-home.html -w '%{http_code}\n' http://localhost:3000
cd ..
git diff --check
```

Expected: all tests pass, TypeScript exits `0`, localhost returns `200`, and `git diff --check` exits `0`.

- [ ] **Step 6: Commit the rendering implementation**

```bash
git add bot/src/lib/premium-decay.ts bot/src/lib/premium-decay.test.ts bot/src/components/premium-decay-chart.tsx docs/superpowers/plans/2026-06-01-premium-decay-linear-area-rendering.md
git commit -m "RALPH: render premium decay as linear minute areas"
```
