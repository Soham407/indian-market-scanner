-- Ensure row exists and RLS policy allows anon/authenticated read
alter table public.bot_settings disable row level security;
alter table public.bot_settings enable row level security;

delete from public.bot_settings where id = 1;

insert into public.bot_settings (id, trading_enabled, paper_capital, daily_drawdown_cap)
values (1, true, 100000, 3000);

drop policy if exists "Public can read bot settings" on public.bot_settings;
create policy "Public can read bot settings"
  on public.bot_settings for select
  to public
  using (true);

grant select on public.bot_settings to anon, authenticated, service_role;
