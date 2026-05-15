-- Fix mutable search_path on set_updated_at trigger function
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Add INSERT/UPDATE grants and RLS policies so shadow trade functions
-- can run as SECURITY INVOKER instead of SECURITY DEFINER
grant insert, update on public.shadow_trades to authenticated;

create policy "Users can insert own shadow trades"
  on public.shadow_trades for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own shadow trades"
  on public.shadow_trades for update
  to authenticated
  using (user_id = auth.uid());

-- Switch open_shadow_trade to SECURITY INVOKER
create or replace function public.open_shadow_trade(
  p_alert_id uuid,
  p_quantity integer default 1
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_alert public.alerts%rowtype;
  v_side  public.shadow_trade_side;
  v_trade_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be positive';
  end if;

  select *
  into v_alert
  from public.alerts
  where id = p_alert_id
    and status = 'active';

  if not found then
    raise exception 'Active alert not found';
  end if;

  v_side := case
    when v_alert.direction = 'bearish' then 'short'::public.shadow_trade_side
    else 'long'::public.shadow_trade_side
  end;

  insert into public.shadow_trades (
    user_id,
    alert_id,
    instrument_id,
    side,
    quantity,
    entry_price,
    current_price,
    entry_reason
  )
  values (
    auth.uid(),
    v_alert.id,
    v_alert.instrument_id,
    v_side,
    p_quantity,
    v_alert.current_price,
    v_alert.current_price,
    'Liquidity Trap Alert shadow trade'
  )
  returning id into v_trade_id;

  return v_trade_id;
end;
$$;

-- Switch close_shadow_trade to SECURITY INVOKER (preserves fresh-price logic)
create or replace function public.close_shadow_trade(p_trade_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_trade_id uuid;
  v_price    numeric(14, 4);
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select i.last_price
  into v_price
  from public.shadow_trades st
  join public.instruments i on i.id = st.instrument_id
  where st.id = p_trade_id
    and st.user_id = auth.uid()
    and st.status = 'open';

  if v_price is null then
    raise exception 'Open shadow trade not found or no price available';
  end if;

  update public.shadow_trades
  set
    status       = 'closed',
    current_price = v_price,
    exit_price   = v_price,
    closed_at    = now(),
    exit_reason  = 'Manual close'
  where id = p_trade_id
    and user_id = auth.uid()
    and status  = 'open'
  returning id into v_trade_id;

  if v_trade_id is null then
    raise exception 'Open shadow trade not found';
  end if;

  return v_trade_id;
end;
$$;

-- Tighten grants: no anon access to shadow trade functions
revoke all on function public.open_shadow_trade(uuid, integer) from public, anon;
revoke all on function public.close_shadow_trade(uuid) from public, anon;
grant execute on function public.open_shadow_trade(uuid, integer) to authenticated;
grant execute on function public.close_shadow_trade(uuid) to authenticated;

-- Switch expire_stale_alerts to SECURITY INVOKER; cron runs as postgres (superuser)
-- so it retains access; anon/authenticated should never call this directly
create or replace function public.expire_stale_alerts()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  with updated as (
    update public.alerts
    set status = 'expired'
    where status  = 'active'
      and expires_at is not null
      and expires_at <= now()
    returning 1
  )
  select count(*) into v_count from updated;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_alerts() from public, anon, authenticated;

-- Revoke public rls_auto_enable from anon/authenticated (utility/admin function)
do $$
begin
  revoke all on function public.rls_auto_enable() from public, anon, authenticated;
exception
  when undefined_function then null;
end $$;
