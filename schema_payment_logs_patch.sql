-- 医院回款日志专用 SQL
-- 用法：在 Supabase SQL Editor 里整段执行一次。

create table if not exists public.payment_logs (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  action text not null,
  hospital text not null,
  detail text default '',
  amount integer default 0,
  created_at timestamptz default now()
);

alter table public.payment_logs enable row level security;

create index if not exists idx_payment_logs_user on public.payment_logs(user_id);
create index if not exists idx_payment_logs_created on public.payment_logs(created_at);

drop policy if exists payment_logs_select_access on public.payment_logs;
drop policy if exists payment_logs_write_access on public.payment_logs;

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
