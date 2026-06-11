-- Manual promotion: orb_breakout → paper_live_small (2026-06-11)
-- Reason: strategy has been shadow-tracking quality signals (e.g. ICICIBANK score 82)
-- since the June 5 cost-aware engine migration demoted it. Quality score ≥60 + NIFTY
-- regime filters already enforced by the scanner act as the selectivity gate.
-- Risk multiplier kept at 0.1250 (conservative sizing set during June 5 migration).
update public.bot_strategies
set
  lifecycle_status = 'paper_live_small',
  updated_at = now()
where name = 'orb_breakout'
  and lifecycle_status = 'shadow'
  and version = 'v1';
