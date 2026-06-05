create or replace function public.bot_reject_shadow_signal(
  p_signal_id uuid,
  p_rejection_reason text,
  p_processed_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.bot_signal_outcomes
  where signal_id = p_signal_id
    and mode = 'shadow';

  update public.bot_trade_signals
  set
    status = 'rejected',
    rejection_reason = p_rejection_reason,
    processed_at = p_processed_at
  where id = p_signal_id;
end;
$$;

create or replace function public.bot_reject_paper_trade(
  p_signal_id uuid,
  p_trade_id uuid,
  p_rejection_reason text,
  p_processed_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.bot_signal_outcomes
  where paper_trade_id = p_trade_id;

  delete from public.bot_paper_trades
  where id = p_trade_id;

  update public.bot_trade_signals
  set
    status = 'rejected',
    rejection_reason = p_rejection_reason,
    processed_at = p_processed_at
  where id = p_signal_id;
  end;
$$;

create or replace function public.bot_track_shadow_signal(
  p_signal_id uuid,
  p_entry_price numeric,
  p_processed_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bot_signal_outcomes (
    signal_id,
    mode,
    entry_price,
    status,
    opened_at
  ) values (
    p_signal_id,
    'shadow',
    p_entry_price,
    'open',
    p_processed_at
  );

  update public.bot_trade_signals
  set
    status = 'shadow_tracked',
    processed_at = p_processed_at
  where id = p_signal_id;
end;
$$;

create or replace function public.bot_accept_paper_signal(
  p_signal_id uuid,
  p_strategy_id uuid,
  p_instrument_id uuid,
  p_side text,
  p_entry_price numeric,
  p_entry_slippage_pct numeric,
  p_stop_loss_price numeric,
  p_target_price numeric,
  p_shares integer,
  p_risk_amount numeric,
  p_processed_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade_id uuid;
begin
  insert into public.bot_paper_trades (
    strategy_id,
    instrument_id,
    side,
    entry_price,
    entry_time,
    entry_slippage_pct,
    stop_loss_price,
    target_price,
    shares,
    status,
    risk_amount
  ) values (
    p_strategy_id,
    p_instrument_id,
    p_side,
    p_entry_price,
    p_processed_at,
    p_entry_slippage_pct,
    p_stop_loss_price,
    p_target_price,
    p_shares,
    'open',
    p_risk_amount
  )
  returning id into v_trade_id;

  insert into public.bot_signal_outcomes (
    signal_id,
    paper_trade_id,
    mode,
    entry_price,
    status,
    opened_at
  ) values (
    p_signal_id,
    v_trade_id,
    'paper_live',
    p_entry_price,
    'open',
    p_processed_at
  );

  update public.bot_trade_signals
  set
    status = 'accepted',
    processed_at = p_processed_at
  where id = p_signal_id;

  return v_trade_id;
end;
$$;

grant execute on function public.bot_reject_shadow_signal(uuid, text, timestamptz) to service_role;
grant execute on function public.bot_reject_paper_trade(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.bot_track_shadow_signal(uuid, numeric, timestamptz) to service_role;
grant execute on function public.bot_accept_paper_signal(uuid, uuid, uuid, text, numeric, numeric, numeric, numeric, integer, numeric, timestamptz) to service_role;
