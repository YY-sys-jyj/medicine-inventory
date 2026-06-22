-- 日志功能修复专用 SQL
-- 用法：在 Supabase SQL Editor 里清空旧内容，整份复制本文件后执行。

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

alter table public.inventory_logs enable row level security;
alter table public.delete_logs enable row level security;
alter table public.payment_logs enable row level security;

create index if not exists idx_inventory_logs_user on public.inventory_logs(user_id);
create index if not exists idx_inventory_logs_product on public.inventory_logs(product_id);
create index if not exists idx_delete_logs_user on public.delete_logs(user_id);
create index if not exists idx_delete_logs_created on public.delete_logs(created_at);
create index if not exists idx_payment_logs_user on public.payment_logs(user_id);
create index if not exists idx_payment_logs_created on public.payment_logs(created_at);

drop policy if exists inventory_logs_own on public.inventory_logs;
drop policy if exists inventory_logs_select_access on public.inventory_logs;
drop policy if exists inventory_logs_write_access on public.inventory_logs;
drop policy if exists delete_logs_select_access on public.delete_logs;
drop policy if exists delete_logs_write_access on public.delete_logs;
drop policy if exists payment_logs_select_access on public.payment_logs;
drop policy if exists payment_logs_write_access on public.payment_logs;

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
