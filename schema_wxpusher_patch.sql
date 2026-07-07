-- WxPusher binding and push-status patch.
-- Copy the whole file into Supabase SQL Editor and run it once.

create table if not exists public.wechat_bindings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wxpusher_uid text default '',
  enabled boolean not null default true,
  pushplus_receiver text default '',
  pushplus_bind_code text default '',
  pushplus_friend_id text default '',
  pushplus_friend_nick text default '',
  pushplus_bound_at timestamptz,
  pushplus_token text default '',
  pushplus_enabled boolean not null default false,
  reminder_morning_time text not null default '08:00',
  reminder_evening_time text not null default '17:00',
  reminder_morning_enabled boolean not null default true,
  reminder_evening_enabled boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_wechat_bindings_uid
on public.wechat_bindings(wxpusher_uid);

alter table public.wechat_bindings enable row level security;

alter table public.wechat_bindings
add column if not exists pushplus_receiver text default '';

alter table public.wechat_bindings
add column if not exists pushplus_bind_code text default '';

alter table public.wechat_bindings
add column if not exists pushplus_friend_id text default '';

alter table public.wechat_bindings
add column if not exists pushplus_friend_nick text default '';

alter table public.wechat_bindings
add column if not exists pushplus_bound_at timestamptz;

alter table public.wechat_bindings
add column if not exists pushplus_token text default '';

alter table public.wechat_bindings
add column if not exists pushplus_enabled boolean not null default false;

alter table public.wechat_bindings
add column if not exists reminder_morning_time text not null default '08:00';

alter table public.wechat_bindings
add column if not exists reminder_evening_time text not null default '17:00';

alter table public.wechat_bindings
add column if not exists reminder_morning_enabled boolean not null default true;

alter table public.wechat_bindings
add column if not exists reminder_evening_enabled boolean not null default true;

alter table public.wechat_bindings
alter column wxpusher_uid drop not null;

alter table public.wechat_bindings
alter column wxpusher_uid set default '';

alter table public.notification_events
add column if not exists wxpusher_sent_at timestamptz;

alter table public.notification_events
add column if not exists wxpusher_error text;

alter table public.notification_events
add column if not exists pushplus_sent_at timestamptz;

alter table public.notification_events
add column if not exists pushplus_error text;

create table if not exists public.pushplus_bind_sessions (
  bind_code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  qr_code_url text default '',
  status text not null default 'pending',
  friend_token text default '',
  friend_id text default '',
  friend_nick text default '',
  raw_payload jsonb,
  expires_at timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_pushplus_bind_sessions_user
on public.pushplus_bind_sessions(user_id, created_at desc);

alter table public.pushplus_bind_sessions enable row level security;

drop policy if exists pushplus_bind_sessions_select_own on public.pushplus_bind_sessions;

create policy pushplus_bind_sessions_select_own
on public.pushplus_bind_sessions
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

drop policy if exists wechat_bindings_select_own on public.wechat_bindings;
drop policy if exists wechat_bindings_insert_own on public.wechat_bindings;
drop policy if exists wechat_bindings_update_own on public.wechat_bindings;

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
