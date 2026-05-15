alter table public.alerts
add column dedupe_key text;

delete from public.alerts a
using (
  select
    id,
    row_number() over (
      partition by instrument_id, alert_type, direction, swept_level_name, date_trunc('day', detected_at)
      order by detected_at desc, created_at desc
    ) as duplicate_rank
  from public.alerts
) ranked
where a.id = ranked.id
  and ranked.duplicate_rank > 1;

update public.alerts
set dedupe_key = concat_ws(
  ':',
  instrument_id::text,
  alert_type,
  direction::text,
  swept_level_name,
  date_trunc('day', detected_at)::date::text
);

alter table public.alerts
alter column dedupe_key set not null;

create unique index alerts_dedupe_key_idx on public.alerts (dedupe_key);
