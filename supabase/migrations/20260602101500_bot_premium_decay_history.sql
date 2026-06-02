-- Expose completed premium-decay sessions for the dashboard history picker and
-- keep at most 30 completed IST calendar dates plus the current live date.

create or replace view public.bot_premium_decay_sessions
with (security_invoker = true)
as
select distinct
  (sampled_at at time zone 'Asia/Kolkata')::date as session_date
from public.bot_premium_decay_points
where series_key = 'NIFTY-ATM-WEEKLY'
  and (sampled_at at time zone 'Asia/Kolkata')::date < (now() at time zone 'Asia/Kolkata')::date
  and (sampled_at at time zone 'Asia/Kolkata')::date >= (now() at time zone 'Asia/Kolkata')::date - 30;

grant select on public.bot_premium_decay_sessions to anon, authenticated;

create or replace function public.bot_purge_expired_premium_decay_points()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with deleted as (
    delete from public.bot_premium_decay_points
    where sampled_at < (
      ((now() at time zone 'Asia/Kolkata')::date - 30)::timestamp
      at time zone 'Asia/Kolkata'
    )
    returning 1
  )
  select count(*) into v_count from deleted;

  return v_count;
end;
$$;

revoke all on function public.bot_purge_expired_premium_decay_points() from public, anon, authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'bot-premium-decay-retention';

select cron.schedule(
  'bot-premium-decay-retention',
  '30 18 * * *', -- 18:30 UTC = 00:00 IST
  $$ select public.bot_purge_expired_premium_decay_points(); $$
);
