create or replace function public.expire_stale_alerts()
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
    set status = 'expired'
    where status = 'active'
      and expires_at is not null
      and expires_at <= now()
    returning 1
  )
  select count(*) into v_count from updated;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_alerts() from public;

select cron.unschedule(jobid)
from cron.job
where jobname = 'market-sniper-expire-alerts';

select cron.schedule(
  'market-sniper-expire-alerts',
  '*/5 * * * *',
  $$ select public.expire_stale_alerts(); $$
);
