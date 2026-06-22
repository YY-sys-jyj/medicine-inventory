-- ============================================
-- 订阅/试用访问控制策略
-- 在 Supabase SQL Editor 中执行
-- 目标：试用期内可读写；到期后 3 天只读；3 天后暂停读写。
-- 管理员和超级管理员不受限制。
-- ============================================

create or replace function public.current_user_access_state(target_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.user_roles
      where user_id = auth.uid()
        and role in ('super_admin', 'admin')
    ) then 'active'
    when exists (
      select 1 from public.user_roles
      where user_id = target_user
        and paid_until is not null
        and paid_until > now()
    ) then 'active'
    when exists (
      select 1 from public.user_roles
      where user_id = target_user
        and trial_ends_at is not null
        and trial_ends_at > now()
    ) then 'active'
    when exists (
      select 1 from public.user_roles
      where user_id = target_user
        and trial_ends_at is not null
        and trial_ends_at <= now()
        and trial_ends_at + interval '3 days' > now()
    ) then 'grace'
    else 'locked'
  end;
$$;

alter table public.user_roles add column if not exists phone text;
create index if not exists idx_user_roles_phone on public.user_roles(phone);

create table if not exists public.inventory_logs (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  product_id text,
  product_name text not null,
  type text not null,
  quantity integer default 0,
  stock_after integer default 0,
  note text default '',
  created_at timestamptz default now()
);

alter table public.inventory_logs enable row level security;
create index if not exists idx_inventory_logs_user on public.inventory_logs(user_id);
create index if not exists idx_inventory_logs_product on public.inventory_logs(product_id);

create table if not exists public.delete_logs (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  item_type text not null,
  item_name text not null,
  item_detail text default '',
  created_at timestamptz default now()
);

create table if not exists public.payment_logs (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  action text not null,
  hospital text not null,
  detail text default '',
  amount integer default 0,
  created_at timestamptz default now()
);

alter table public.delete_logs enable row level security;
alter table public.payment_logs enable row level security;
create index if not exists idx_delete_logs_user on public.delete_logs(user_id);
create index if not exists idx_delete_logs_created on public.delete_logs(created_at);
create index if not exists idx_payment_logs_user on public.payment_logs(user_id);
create index if not exists idx_payment_logs_created on public.payment_logs(created_at);

drop policy if exists products_own on public.products;
drop policy if exists payments_own on public.payments;
drop policy if exists products_select_access on public.products;
drop policy if exists products_write_access on public.products;
drop policy if exists payments_select_access on public.payments;
drop policy if exists payments_write_access on public.payments;
drop policy if exists inventory_logs_own on public.inventory_logs;
drop policy if exists inventory_logs_select_access on public.inventory_logs;
drop policy if exists inventory_logs_write_access on public.inventory_logs;
drop policy if exists delete_logs_select_access on public.delete_logs;
drop policy if exists delete_logs_write_access on public.delete_logs;
drop policy if exists payment_logs_select_access on public.payment_logs;
drop policy if exists payment_logs_write_access on public.payment_logs;

create policy products_select_access
on public.products
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy products_write_access
on public.products
for all
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
)
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
);

create policy payments_select_access
on public.payments
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy payments_write_access
on public.payments
for all
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
)
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
);

create policy inventory_logs_select_access
on public.inventory_logs
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy inventory_logs_write_access
on public.inventory_logs
for all
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
)
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
);

create policy delete_logs_select_access
on public.delete_logs
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy delete_logs_write_access
on public.delete_logs
for all
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
)
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
);

create policy payment_logs_select_access
on public.payment_logs
for select
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) in ('active', 'grace')
);

create policy payment_logs_write_access
on public.payment_logs
for all
using (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
)
with check (
  auth.uid() = user_id
  and public.current_user_access_state(user_id) = 'active'
);

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

create unique index if not exists idx_notification_events_user_dedupe on public.notification_events(user_id, dedupe_key);
create index if not exists idx_notification_events_user_created on public.notification_events(user_id, created_at desc);
create index if not exists idx_notification_events_user_unread on public.notification_events(user_id, read_at) where read_at is null;
alter table public.notification_events enable row level security;

create table if not exists public.system_announcements (
  id bigserial primary key,
  title text not null,
  content text not null,
  target_role text not null default 'all',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_system_announcements_created on public.system_announcements(created_at desc);
alter table public.system_announcements enable row level security;

drop policy if exists notification_events_select_access on public.notification_events;
drop policy if exists notification_events_insert_access on public.notification_events;
drop policy if exists notification_events_update_access on public.notification_events;
drop policy if exists system_announcements_select_access on public.system_announcements;
drop policy if exists system_announcements_insert_admin on public.system_announcements;

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

-- ============================================
-- 管理员层级更新权限
-- 超级管理员：可管理管理员和普通用户
-- 管理员：只能管理普通用户，且不能把普通用户提升为管理员
-- 普通用户：不能直接更新订阅/角色信息，避免绕过页面自行续期
-- ============================================

drop policy if exists users_update_own_profile on public.user_roles;
drop policy if exists users_insert_own_role on public.user_roles;
drop policy if exists admins_update_users on public.user_roles;
drop policy if exists admins_delete_users on public.user_roles;

create policy users_insert_own_role
on public.user_roles
for insert
with check (
  auth.uid() = user_id
  and role = 'user'
);

create policy admins_update_users
on public.user_roles
for update
using (
  exists (
    select 1 from public.user_roles me
    where me.user_id = auth.uid()
      and me.role = 'super_admin'
  )
  or (
    role = 'user'
    and exists (
      select 1 from public.user_roles me
      where me.user_id = auth.uid()
        and me.role = 'admin'
    )
  )
)
with check (
  exists (
    select 1 from public.user_roles me
    where me.user_id = auth.uid()
      and me.role = 'super_admin'
  )
  or (
    role = 'user'
    and exists (
      select 1 from public.user_roles me
      where me.user_id = auth.uid()
        and me.role = 'admin'
    )
  )
);

create policy admins_delete_users
on public.user_roles
for delete
using (
  exists (
    select 1 from public.user_roles me
    where me.user_id = auth.uid()
      and me.role = 'super_admin'
  )
  or (
    role = 'user'
    and exists (
      select 1 from public.user_roles me
      where me.user_id = auth.uid()
        and me.role = 'admin'
    )
  )
);
