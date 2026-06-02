alter table public.bot_premium_decay_points
  add column if not exists sampled_minute timestamptz;

update public.bot_premium_decay_points
set sampled_minute = date_trunc('minute', sampled_at)
where sampled_minute is null;

alter table public.bot_premium_decay_points
  alter column sampled_minute set default date_trunc('minute', now()),
  alter column sampled_minute set not null;

delete from public.bot_premium_decay_points point
using public.bot_premium_decay_points duplicate
where point.id > duplicate.id
  and point.series_key = 'NIFTY-ATM-WEEKLY'
  and duplicate.series_key = 'NIFTY-ATM-WEEKLY'
  and point.sampled_minute = duplicate.sampled_minute;

delete from public.bot_premium_decay_points point
using public.bot_premium_decay_points duplicate
where point.id > duplicate.id
  and point.series_key = 'NIFTY-BAND-WEEKLY'
  and duplicate.series_key = 'NIFTY-BAND-WEEKLY'
  and point.strike = duplicate.strike
  and point.sampled_minute = duplicate.sampled_minute;

create unique index if not exists bot_premium_decay_points_atm_minute_key
  on public.bot_premium_decay_points (series_key, sampled_minute)
  where series_key = 'NIFTY-ATM-WEEKLY';

create unique index if not exists bot_premium_decay_points_band_strike_minute_key
  on public.bot_premium_decay_points (series_key, strike, sampled_minute)
  where series_key = 'NIFTY-BAND-WEEKLY';

alter table public.bot_settings
  add column if not exists premium_decay_last_sample_at timestamptz,
  add column if not exists premium_decay_last_error_at timestamptz,
  add column if not exists premium_decay_last_error_message text;

create or replace function public.bot_replace_premium_decay_minute(
  p_sampled_minute timestamptz,
  p_points jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) = 0 then
    raise exception 'p_points must be a non-empty JSON array';
  end if;

  delete from public.bot_premium_decay_points
  where sampled_minute = date_trunc('minute', p_sampled_minute)
    and series_key in ('NIFTY-ATM-WEEKLY', 'NIFTY-BAND-WEEKLY');

  insert into public.bot_premium_decay_points (
    series_key,
    instrument_symbol,
    expiry_date,
    strike,
    sampled_at,
    sampled_minute,
    underlying_ltp,
    ce_ltp,
    pe_ltp,
    ce_decay,
    pe_decay
  )
  select
    point.series_key,
    point.instrument_symbol,
    point.expiry_date,
    point.strike,
    point.sampled_at,
    date_trunc('minute', p_sampled_minute),
    point.underlying_ltp,
    point.ce_ltp,
    point.pe_ltp,
    point.ce_decay,
    point.pe_decay
  from jsonb_to_recordset(p_points) as point (
    series_key text,
    instrument_symbol text,
    expiry_date date,
    strike numeric,
    sampled_at timestamptz,
    underlying_ltp numeric,
    ce_ltp numeric,
    pe_ltp numeric,
    ce_decay numeric,
    pe_decay numeric
  );

  get diagnostics v_count = row_count;

  update public.bot_settings
  set premium_decay_last_sample_at = p_sampled_minute,
      premium_decay_last_error_at = null,
      premium_decay_last_error_message = null
  where id = 1;

  update public.bot_incidents
  set resolved_at = now()
  where source = 'bot-premium-decay'
    and resolved_at is null;

  return v_count;
end;
$$;

revoke all on function public.bot_replace_premium_decay_minute(timestamptz, jsonb)
  from public, anon, authenticated;

grant execute on function public.bot_replace_premium_decay_minute(timestamptz, jsonb)
  to service_role;
