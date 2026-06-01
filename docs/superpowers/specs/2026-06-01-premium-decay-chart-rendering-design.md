# Premium Decay Chart Rendering Design

## Goal

Render the live NIFTY ATM premium-movement chart in the same visual style as the supplied reference: continuous green CE and muted-red PE filled areas around a prominent zero baseline.

## Rendering Rules

- Use one timeline slot per market minute.
- Connect adjacent minute slots with straight line segments.
- Fill each CE and PE line independently back to the zero baseline.
- Do not use stair-step transitions or curve smoothing.
- Preserve signed CE and PE movement values so either series may cross the zero baseline.
- If a minute is missing because the market-data request failed, carry the previous known value forward for that minute. This preserves a continuous one-minute timeline without inventing a diagonal multi-minute movement.
- Keep X-axis labels sparse enough to remain readable while retaining one-minute grid spacing.

## Data Flow

The existing Supabase pipeline remains unchanged:

1. The `bot-premium-decay` Edge Function collects one sample per minute during NSE market hours.
2. `bot_premium_decay_points` stores the signed movement values.
3. The Next.js chart loads recent rows, subscribes to Supabase Realtime inserts, and refreshes every 30 seconds as a fallback.
4. The frontend expands collected rows into one-minute slots before rendering.

## Failure Handling

- Angel One REST failures remain retried by the Edge Function.
- If all retries fail for a minute, the frontend carries forward the most recent displayed value.
- The chart continues updating when the next successful realtime insert arrives.

## Verification

- Unit-test one-minute carry-forward slot generation.
- Unit-test linear path generation so adjacent minute samples create one straight segment rather than a stair step.
- Run the frontend test suite and TypeScript compiler.
- Confirm the local dashboard returns HTTP `200`.
