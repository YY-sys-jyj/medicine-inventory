-- PushPlus receiver-channel patch.
-- Run this after schema_wxpusher_patch.sql.
-- The Edge Function uses a system-level PUSHPLUS_TOKEN secret to send messages.
-- Users only bind their PushPlus receiver/friend token here; they do not need to provide a sender token.

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
