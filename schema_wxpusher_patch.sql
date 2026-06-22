-- WxPusher binding and push-status patch.
-- Copy the whole file into Supabase SQL Editor and run it once.

create table if not exists public.wechat_bindings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wxpusher_uid text not null,
  enabled boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_wechat_bindings_uid
on public.wechat_bindings(wxpusher_uid);

alter table public.wechat_bindings enable row level security;

alter table public.notification_events
add column if not exists wxpusher_sent_at timestamptz;

alter table public.notification_events
add column if not exists wxpusher_error text;

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
