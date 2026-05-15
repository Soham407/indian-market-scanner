create or replace function public.close_shadow_trade(p_trade_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade_id uuid;
  v_price numeric(14, 4);
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
    status = 'closed',
    current_price = v_price,
    exit_price = v_price,
    closed_at = now(),
    exit_reason = 'Manual close'
  where id = p_trade_id
    and user_id = auth.uid()
    and status = 'open'
  returning id into v_trade_id;

  if v_trade_id is null then
    raise exception 'Open shadow trade not found';
  end if;

  return v_trade_id;
end;
$$;
