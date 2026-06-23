-- PushPlus receiver-channel patch.
-- Run this after schema_wxpusher_patch.sql.
-- The Edge Function uses a system-level PUSHPLUS_TOKEN secret to send messages.
-- Users only bind their PushPlus receiver/friend token here; they do not need to provide a sender token.

alter table public.wechat_bindings
add column if not exists pushplus_receiver text default '';

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
