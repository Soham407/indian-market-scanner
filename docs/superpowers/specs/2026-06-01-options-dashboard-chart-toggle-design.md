# Options Dashboard Chart Toggle Design

## Goal

Show one options premium-decay chart at a time and keep CE/PE area fills inside the plotted axis rectangle.

## UI Behavior

- Default to the existing `NIFTY premium decay` ATM chart.
- Add a compact two-button selector above the chart slot: `ATM premium decay` and `Band average`.
- Render only the selected chart component so the hidden graph does not fetch data or subscribe to Supabase Realtime.
- Keep the selected chart full width.

## Chart Rendering

- Define the plot rectangle from the existing SVG margins.
- Add an SVG `clipPath` for each chart.
- Clip the CE/PE filled areas and line strokes to the plot rectangle.
- Leave axis labels, legends, and hover tooltip outside the clipped group.

## Verification

- Unit-test the default chart selection and selection visibility helper.
- Unit-test the plot clip rectangle geometry.
- Run Vitest, TypeScript compilation, production build, and `git diff --check`.
- Inspect the local dashboard in the browser and switch between both graph modes.
