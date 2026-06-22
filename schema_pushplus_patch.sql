-- PushPlus channel patch.
-- Run this after schema_wxpusher_patch.sql, or rerun schema_wxpusher_patch.sql after this update.

alter table public.wechat_bindings
add column if not exists pushplus_token text default '';

alter table public.wechat_bindings
add column if not exists pushplus_enabled boolean not null default false;

alter table public.wechat_bindings
alter column wxpusher_uid drop not null;

alter table public.wechat_bindings
alter column wxpusher_uid set default '';

alter table public.notification_events
add column if not exists pushplus_sent_at timestamptz;

alter table public.notification_events
add column if not exists pushplus_error text;
