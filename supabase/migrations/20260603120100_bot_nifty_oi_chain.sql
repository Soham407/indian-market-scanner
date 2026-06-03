create table if not exists public.bot_nifty_oi_chain (
  id             uuid primary key default gen_random_uuid(),
  sampled_at     timestamptz not null default now(),
  session_date   date not null,
  expiry_date    date not null,
  strike         numeric(14, 4) not null,
  ce_oi          bigint not null default 0,
  pe_oi          bigint not null default 0,
  ce_ltp         numeric(14, 4),
  pe_ltp         numeric(14, 4),
  underlying_ltp numeric(14, 4) not null,
  created_at     timestamptz not null default now()
);

create index if not exists bot_nifty_oi_chain_session_sampled_idx
  on public.bot_nifty_oi_chain (session_date, sampled_at desc);

alter table public.bot_nifty_oi_chain enable row level security;

grant select on public.bot_nifty_oi_chain to anon, authenticated;

drop policy if exists "Public can read bot nifty oi chain" on public.bot_nifty_oi_chain;
create policy "Public can read bot nifty oi chain"
  on public.bot_nifty_oi_chain for select
  to anon, authenticated
  using (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.bot_nifty_oi_chain;
  exception
    when duplicate_object then null;
  end;
end;
$$;
