-- Notification center patch.
-- Copy the whole file into Supabase SQL Editor and run it once.

create table if not exists public.notification_events (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  type text not null,
  severity text not null default 'info',
  title text not null,
  content text default '',
  source_type text default '',
  source_key text default '',
  dedupe_key text not null,
  read_at timestamptz,
  created_at timestamptz default now()
);

create unique index if not exists idx_notification_events_user_dedupe
on public.notification_events(user_id, dedupe_key);

create index if not exists idx_notification_events_user_created
on public.notification_events(user_id, created_at desc);

create index if not exists idx_notification_events_user_unread
on public.notification_events(user_id, read_at)
where read_at is null;

alter table public.notification_events enable row level security;

alter table public.notification_events
add column if not exists wxpusher_sent_at timestamptz;

alter table public.notification_events
add column if not exists wxpusher_error text;

alter table public.notification_events
add column if not exists pushplus_sent_at timestamptz;

alter table public.notification_events
add column if not exists pushplus_error text;

create table if not exists public.wechat_bindings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wxpusher_uid text default '',
  enabled boolean not null default true,
  pushplus_token text default '',
  pushplus_enabled boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_wechat_bindings_uid
on public.wechat_bindings(wxpusher_uid);

alter table public.wechat_bindings enable row level security;

alter table public.wechat_bindings
add column if not exists pushplus_token text default '';

alter table public.wechat_bindings
add column if not exists pushplus_enabled boolean not null default false;

alter table public.wechat_bindings
alter column wxpusher_uid drop not null;

alter table public.wechat_bindings
alter column wxpusher_uid set default '';

create table if not exists public.system_announcements (
  id bigserial primary key,
  title text not null,
  content text not null,
  target_role text not null default 'all',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_system_announcements_created
on public.system_announcements(created_at desc);

alter table public.system_announcements enable row level security;

drop policy if exists notification_events_select_access on public.notification_events;
drop policy if exists notification_events_insert_access on public.notification_events;
drop policy if exists notification_events_update_access on public.notification_events;
drop policy if exists system_announcements_select_access on public.system_announcements;
drop policy if exists system_announcements_insert_admin on public.system_announcements;
drop policy if exists wechat_bindings_select_own on public.wechat_bindings;
drop policy if exists wechat_bindings_insert_own on public.wechat_bindings;
drop policy if exists wechat_bindings_update_own on public.wechat_bindings;

create policy notification_events_select_access
on public.notification_events
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy notification_events_insert_access
on public.notification_events
for insert
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
);

create policy notification_events_update_access
on public.notification_events
for update
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
)
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy system_announcements_select_access
on public.system_announcements
for select
using (
  exists (
    select 1
    from public.user_roles me
    where me.user_id = auth.uid()
      and public.current_user_access_state(me.user_id) in ('active', 'grace')
      and (
        target_role = 'all'
        or target_role = me.role
        or (target_role = 'admin' and me.role in ('admin', 'super_admin'))
      )
  )
);

create policy system_announcements_insert_admin
on public.system_announcements
for insert
with check (
  created_by = auth.uid()
  and target_role in ('all', 'user', 'admin', 'super_admin')
  and exists (
    select 1
    from public.user_roles me
    where me.user_id = auth.uid()
      and me.role in ('admin', 'super_admin')
  )
);

create policy wechat_bindings_select_own
on public.wechat_bindings
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy wechat_bindings_insert_own
on public.wechat_bindings
for insert
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy wechat_bindings_update_own
on public.wechat_bindings
for update
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
)
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);
