create table if not exists public.bot_premium_decay_points (
  id uuid primary key default gen_random_uuid(),
  series_key text not null,
  instrument_symbol text not null,
  expiry_date date not null,
  strike numeric(14, 4) not null,
  sampled_at timestamptz not null default now(),
  underlying_ltp numeric(14, 4) not null,
  ce_ltp numeric(14, 4) not null,
  pe_ltp numeric(14, 4) not null,
  ce_decay numeric(14, 4) not null,
  pe_decay numeric(14, 4) not null,
  created_at timestamptz not null default now(),
  constraint bot_premium_decay_points_positive_values_check check (
    strike > 0
    and underlying_ltp > 0
    and ce_ltp >= 0
    and pe_ltp >= 0
  )
);

create index if not exists bot_premium_decay_points_series_key_sampled_at_idx
  on public.bot_premium_decay_points (series_key, sampled_at desc);

alter table public.bot_premium_decay_points enable row level security;

grant select on public.bot_premium_decay_points to anon, authenticated;

drop policy if exists "Public can read bot premium decay points" on public.bot_premium_decay_points;
create policy "Public can read bot premium decay points"
on public.bot_premium_decay_points for select
to anon, authenticated
using (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.bot_premium_decay_points;
  exception
    when duplicate_object then
      null;
  end;
end;
$$;
