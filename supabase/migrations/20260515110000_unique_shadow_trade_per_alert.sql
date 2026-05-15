delete from public.shadow_trades st
using (
  select
    id,
    row_number() over (
      partition by user_id, alert_id
      order by created_at asc, opened_at asc, id asc
    ) as duplicate_rank
  from public.shadow_trades
  where alert_id is not null
) ranked
where st.id = ranked.id
  and ranked.duplicate_rank > 1;

alter table public.shadow_trades
add constraint shadow_trades_user_alert_unique unique (user_id, alert_id);

create or replace function public.open_shadow_trade(
  p_alert_id uuid,
  p_quantity integer default 1
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert public.alerts%rowtype;
  v_side public.shadow_trade_side;
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
exception
  when unique_violation then
    raise exception 'Shadow trade already exists for this alert'
      using errcode = '23505';
end;
$$;
