delete from public.shadow_trades
where alert_id in (
  select id
  from public.alerts
  where market_session = 'qa'
    or dedupe_key like 'qa:%'
);

delete from public.alerts
where market_session = 'qa'
  or dedupe_key like 'qa:%'
  or thesis ilike '%QA alert:%'
  or thesis ilike '%elevated volume and faded back toward VWAP%';

delete from public.price_marks
where instrument_id in (
  select id
  from public.instruments
  where (exchange, symbol) in (
    ('NSE', 'RELIANCE'),
    ('NSE', 'HDFCBANK'),
    ('NSE', 'INFY')
  )
);

delete from public.instruments i
where (i.exchange, i.symbol) in (
    ('NSE', 'RELIANCE'),
    ('NSE', 'HDFCBANK'),
    ('NSE', 'INFY')
  )
  and not exists (
    select 1
    from public.shadow_trades st
    where st.instrument_id = i.id
  )
  and not exists (
    select 1
    from public.alerts a
    where a.instrument_id = i.id
  );
