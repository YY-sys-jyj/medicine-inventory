-- Per-user reminder schedule patch.
-- Copy this whole file into Supabase SQL Editor and run it once.

alter table public.wechat_bindings
add column if not exists reminder_morning_time text not null default '08:00';

alter table public.wechat_bindings
add column if not exists reminder_evening_time text not null default '17:00';

alter table public.wechat_bindings
add column if not exists reminder_morning_enabled boolean not null default true;

alter table public.wechat_bindings
add column if not exists reminder_evening_enabled boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'wechat_bindings_reminder_morning_time_format'
  ) then
    alter table public.wechat_bindings
    add constraint wechat_bindings_reminder_morning_time_format
    check (reminder_morning_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'wechat_bindings_reminder_evening_time_format'
  ) then
    alter table public.wechat_bindings
    add constraint wechat_bindings_reminder_evening_time_format
    check (reminder_evening_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  end if;
end $$;
