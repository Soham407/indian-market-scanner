-- Midnight IST sweep: expire all active alerts at 00:00 IST (18:30 UTC).
-- This moves every alert from the live feed into the History tab daily,
-- so the dashboard always starts fresh at each trading day.

create or replace function public.midnight_sweep_alerts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with updated as (
    update public.alerts
    set    status = 'expired'
    where  status = 'active'
    returning 1
  )
  select count(*) into v_count from updated;
  return v_count;
end;
$$;

revoke all on function public.midnight_sweep_alerts() from public;

select cron.unschedule(jobid)
from cron.job
where jobname = 'market-sniper-midnight-sweep';

select cron.schedule(
  'market-sniper-midnight-sweep',
  '30 18 * * *',  -- 18:30 UTC = 00:00 IST every night
  $$ select public.midnight_sweep_alerts(); $$
);
