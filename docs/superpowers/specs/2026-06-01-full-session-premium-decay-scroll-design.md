# Full-Session Premium Decay Scroll Design

## Goal

Show the complete NSE options-monitoring session from 9:15 am through 3:30 pm while keeping the graph readable through horizontal scrolling.

## Behavior

- Retain 376 one-minute timestamps per ATM series, covering both session endpoints.
- Retain 4,136 band rows, calculated as 376 timestamps across 11 strikes.
- Render each chart on a wider SVG canvas sized for the full session.
- Keep the chart card width unchanged and add a horizontal scrollbar inside the chart frame.
- Position the scrollbar at the newest samples on the right when a chart mounts.
- Preserve existing tooltip, area-fill, and clipping behavior.

## Verification

- Unit-test session retention constants.
- Unit-test the scrollable SVG width calculation.
- Run Vitest, TypeScript compilation, production build, and `git diff --check`.
- Inspect ATM and band-average graphs locally and confirm the scrollbar opens at the latest samples.
