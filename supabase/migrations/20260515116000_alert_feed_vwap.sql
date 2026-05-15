-- Expose instruments.vwap on the alert_feed view so the dashboard can
-- render exact take-profit targets in the Trade Execution Plan ticket.
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
  i.vwap,
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
  a.updated_at
from public.alerts a
join public.instruments i on i.id = a.instrument_id;

revoke all on public.alert_feed from anon, authenticated;
grant select on public.alert_feed to authenticated;
