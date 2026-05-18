-- Add snapshotted take-profit price to alerts so the dashboard shows the
-- correct target regardless of how live VWAP drifts after alert creation.
-- Trap signals (A–D): take_profit_price = VWAP at detection time.
-- OR Breakout signals (E–F): take_profit_price = measured move target
--   (or_high + range for bullish; or_low - range for bearish).
alter table public.alerts
  add column if not exists take_profit_price numeric(14, 4);

-- Rebuild alert_feed view to expose the new column.
create or replace view public.alert_feed
with (security_invoker = true)
as
select
  a.id,
  a.instrument_id,
  i.symbol,
  i.exchange,
  i.name as instrument_name,
  a.alert_type,
  a.direction,
  a.title,
  a.thesis,
  a.trigger_price,
  a.current_price,
  a.swept_level,
  a.swept_level_name,
  a.volume_multiplier,
  a.conviction_score,
  a.score_factors,
  a.timeframe_alignment,
  a.market_session,
  a.status,
  a.detected_at,
  a.expires_at,
  a.created_at,
  a.updated_at,
  i.vwap,
  a.take_profit_price
from public.alerts a
join public.instruments i on i.id = a.instrument_id;

revoke all on public.alert_feed from anon, authenticated;
grant select on public.alert_feed to authenticated;
