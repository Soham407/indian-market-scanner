-- Ensure row 1 exists in bot_settings with defaults
insert into public.bot_settings (id, trading_enabled, paper_capital, daily_drawdown_cap)
values (1, true, 100000, 3000)
on conflict (id) do nothing;
