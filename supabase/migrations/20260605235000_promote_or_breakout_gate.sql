update public.bot_strategies
set
  lifecycle_status = case
    when name = 'or_breakout' then 'paper_live_small'
    when name = 'orb_breakout' then 'shadow'
    when name in ('pdh_trap', 'pdl_bounce', 'or_trap', 'chanakya_bullish') then 'disabled'
    else lifecycle_status
  end,
  risk_multiplier = case
    when name = 'or_breakout' then least(risk_multiplier, 0.25)
    else risk_multiplier
  end,
  max_risk_multiplier = case
    when name = 'or_breakout' then least(max_risk_multiplier, 1.5)
    else max_risk_multiplier
  end,
  updated_at = now()
where name in ('or_breakout', 'orb_breakout', 'pdh_trap', 'pdl_bounce', 'or_trap', 'chanakya_bullish')
  and version = 'v1';
