import { createClient } from "npm:@supabase/supabase-js@2";

type JsonMap = Record<string, unknown>;

let pushplusAccessKey = "";
let pushplusAccessKeyUntil = 0;

const DAY_MS = 86400000;
const RETENTION_DAYS = {
  notifications: 90,
  bindSessions: 30,
  logs: 365,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: JsonMap, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function beijingParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 3600000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function beijingDateKey(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function beijingNowText(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

function reminderSlot(date = new Date()) {
  return beijingParts(date).hour < 12 ? "am" : "pm";
}

function timeToMinutes(value: any, fallback: string) {
  const text = String(value || fallback || "").trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return timeToMinutes(fallback === text ? "08:00" : fallback, "08:00");
  return Number(match[1]) * 60 + Number(match[2]);
}

function reminderSchedule(binding: any) {
  return {
    morningEnabled: binding?.reminder_morning_enabled !== false,
    eveningEnabled: binding?.reminder_evening_enabled !== false,
    morningTime: String(binding?.reminder_morning_time || "08:00"),
    eveningTime: String(binding?.reminder_evening_time || "17:00"),
  };
}

function isReminderDueNow(binding: any, date = new Date()) {
  const schedule = reminderSchedule(binding);
  const parts = beijingParts(date);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const slot = reminderSlot(date);
  if (slot === "am") return schedule.morningEnabled && nowMinutes >= timeToMinutes(schedule.morningTime, "08:00");
  return schedule.eveningEnabled && nowMinutes >= timeToMinutes(schedule.eveningTime, "17:00");
}

function reminderScheduleStatus(binding: any, date = new Date()) {
  const schedule = reminderSchedule(binding);
  const slot = reminderSlot(date);
  const currentEnabled = slot === "am" ? schedule.morningEnabled : schedule.eveningEnabled;
  const currentTargetTime = slot === "am" ? schedule.morningTime : schedule.eveningTime;
  return {
    beijingNow: beijingNowText(date),
    slot,
    schedule,
    currentEnabled,
    currentTargetTime,
    dueNow: isReminderDueNow(binding, date),
    hasBinding: !!binding,
  };
}

function dateOnlyMs(dateText: string) {
  const parts = String(dateText || "").slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function daysUntil(dateText: string) {
  const target = dateOnlyMs(dateText);
  const today = dateOnlyMs(beijingDateKey());
  if (Number.isNaN(target)) return 9999;
  return Math.ceil((target - today) / 86400000);
}

function monthsToExpiry(dateText: string) {
  return daysUntil(dateText) / 31;
}

function fmtDate(value: string) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

function cutoffIso(days: number) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

async function cleanupTable(admin: any, table: string, days: number): Promise<any> {
  try {
    const { count, error } = await admin
      .from(table)
      .delete({ count: "exact" })
      .lt("created_at", cutoffIso(days));
    if (error) return { table, days, deleted: 0, error: error.message };
    return { table, days, deleted: count || 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { table, days, deleted: 0, error: message };
  }
}

async function cleanupOldOperationalData(admin: any) {
  const results: any[] = await Promise.all([
    cleanupTable(admin, "notification_events", RETENTION_DAYS.notifications),
    cleanupTable(admin, "pushplus_bind_sessions", RETENTION_DAYS.bindSessions),
    cleanupTable(admin, "inventory_logs", RETENTION_DAYS.logs),
    cleanupTable(admin, "payment_logs", RETENTION_DAYS.logs),
    cleanupTable(admin, "delete_logs", RETENTION_DAYS.logs),
  ]);
  return {
    retentionDays: RETENTION_DAYS,
    results,
    deleted: results.reduce((sum, item) => sum + (item.deleted || 0), 0),
    errors: results.filter((item) => item.error).map((item) => ({ table: item.table, error: item.error })),
  };
}

function activeOrGrace(role: any) {
  if (!role) return false;
  if (role.role === "admin" || role.role === "super_admin") return true;
  const now = Date.now();
  if (role.paid_until && new Date(role.paid_until).getTime() > now) return true;
  if (role.trial_ends_at) {
    const trial = new Date(role.trial_ends_at).getTime();
    if (trial > now) return true;
    if (trial + 3 * 86400000 > now) return true;
  }
  return false;
}

async function sendWx(appToken: string, uid: string, title: string, content: string) {
  const res = await fetch("https://wxpusher.zjiecode.com/api/send/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appToken,
      contentType: 1,
      summary: title.slice(0, 80),
      content: `${title}\n\n${content}`,
      uids: [uid],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 1000) {
    throw new Error(data.msg || data.message || `WxPusher HTTP ${res.status}`);
  }
  return data;
}

async function sendPushPlus(systemToken: string, receiver: string, title: string, content: string) {
  const res = await fetch("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: systemToken,
      to: receiver,
      title: title.slice(0, 100),
      content: `${title}\n\n${content}`,
      template: "txt",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 200) {
    throw new Error(data.msg || data.message || `PushPlus HTTP ${res.status}`);
  }
  return data;
}

async function getPushPlusAccessKey(token: string, secretKey: string) {
  if (!token) throw new Error("PushPlus 系统发送 Token 未配置");
  if (!secretKey) throw new Error("PushPlus SecretKey 未配置，请在 Supabase Secrets 添加 PUSHPLUS_SECRET_KEY");
  if (pushplusAccessKey && Date.now() < pushplusAccessKeyUntil) return pushplusAccessKey;
  const res = await fetch("https://www.pushplus.plus/api/common/openApi/getAccessKey", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, secretKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 200 || !data.data?.accessKey) {
    throw new Error(data.msg || data.message || `PushPlus AccessKey HTTP ${res.status}`);
  }
  pushplusAccessKey = String(data.data.accessKey);
  const expiresIn = Number(data.data.expiresIn || 7200);
  pushplusAccessKeyUntil = Date.now() + Math.max(60, expiresIn - 300) * 1000;
  return pushplusAccessKey;
}

async function createPushPlusBindQr(admin: any, userId: string, token: string, secretKey: string) {
  const accessKey = await getPushPlusAccessKey(token, secretKey);
  const bindCode = `ysj_${crypto.randomUUID().replaceAll("-", "")}`;
  const seconds = 1800;
  const url = new URL("https://www.pushplus.plus/api/open/friend/getQrCode");
  const appId = Deno.env.get("PUSHPLUS_WECHAT_APP_ID") || "";
  if (appId) url.searchParams.set("appId", appId);
  url.searchParams.set("content", bindCode);
  url.searchParams.set("second", String(seconds));
  url.searchParams.set("scanCount", "-1");
  const res = await fetch(url.toString(), { headers: { "access-key": accessKey } });
  const data = await res.json().catch(() => ({}));
  const qrCodeImgUrl = data.data?.qrCodeImgUrl || data.data?.qrCode || data.data?.url || "";
  if (!res.ok || data.code !== 200 || !qrCodeImgUrl) {
    throw new Error(data.msg || data.message || `PushPlus 二维码生成失败 HTTP ${res.status}`);
  }
  const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  const row = {
    bind_code: bindCode,
    user_id: userId,
    qr_code_url: qrCodeImgUrl,
    status: "pending",
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from("pushplus_bind_sessions").upsert(row, { onConflict: "bind_code" });
  if (error) throw new Error(`${error.message}。请先执行最新 PushPlus SQL`);
  return { bindCode, qrCodeImgUrl, expiresAt };
}

async function bindPushPlusReceiver(admin: any, bindCode: string, friendInfo: any, rawPayload: any) {
  const receiver = String(friendInfo?.token || "").trim();
  if (!bindCode || !receiver) return { ignored: true };
  const { data: session, error } = await admin.from("pushplus_bind_sessions")
    .select("*")
    .eq("bind_code", bindCode)
    .maybeSingle();
  if (error || !session) return { ignored: true };
  if (new Date(session.expires_at).getTime() < Date.now() && session.status !== "bound") {
    await admin.from("pushplus_bind_sessions").update({
      status: "expired",
      raw_payload: rawPayload,
      updated_at: new Date().toISOString(),
    }).eq("bind_code", bindCode);
    return { ignored: true, expired: true };
  }
  const now = new Date().toISOString();
  const friendId = friendInfo?.friendId === undefined ? "" : String(friendInfo.friendId);
  const friendNick = friendInfo?.nickName === undefined ? "" : String(friendInfo.nickName);
  const bindingRow = {
    user_id: session.user_id,
    pushplus_receiver: receiver,
    pushplus_enabled: true,
    pushplus_bind_code: bindCode,
    pushplus_friend_id: friendId,
    pushplus_friend_nick: friendNick,
    pushplus_bound_at: now,
    updated_at: now,
  };
  const { error: bindError } = await admin.from("wechat_bindings").upsert(bindingRow, { onConflict: "user_id" });
  if (bindError) throw new Error(bindError.message);
  await admin.from("pushplus_bind_sessions").update({
    status: "bound",
    friend_token: receiver,
    friend_id: friendId,
    friend_nick: friendNick,
    raw_payload: rawPayload,
    updated_at: now,
  }).eq("bind_code", bindCode);
  return { bound: true, userId: session.user_id };
}

async function handlePushPlusCallback(admin: any, payload: any) {
  if (payload?.event && payload.event !== "add_friend") return json({ code: 200, msg: "success", ignored: true });
  const bindCode = String(payload?.qrCode || payload?.content || payload?.bindCode || "").trim();
  const friendInfo = payload?.friendInfo || payload?.friend || payload?.data || {};
  await bindPushPlusReceiver(admin, bindCode, friendInfo, payload);
  return json({ code: 200, msg: "success" });
}

async function authedUser(req: Request, admin: any) {
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("缺少登录授权");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) throw new Error("登录已过期，请重新登录");
  return data.user;
}

async function userRole(admin: any, userId: string) {
  const { data } = await admin.from("user_roles").select("user_id,role,trial_ends_at,paid_until").eq("user_id", userId).maybeSingle();
  return data;
}

function normalizeCnPhone(value: any) {
  return String(value || "").trim().replace(/^\+?86/, "").replace(/\D/g, "");
}

function userOwnsVerifiedPhone(user: any, phone: string) {
  const normalized = normalizeCnPhone(phone);
  if (!normalized) return false;
  return normalizeCnPhone(user?.phone) === normalized || normalizeCnPhone(user?.user_metadata?.phone) === normalized;
}

async function rolesByPhone(admin: any, phone: string) {
  const normalized = normalizeCnPhone(phone);
  if (!normalized) return [];
  const { data } = await admin
    .from("user_roles")
    .select("user_id,role,phone")
    .eq("phone", normalized)
    .limit(10);
  return data || [];
}

async function bindingFor(admin: any, userId: string) {
  const { data } = await admin.from("wechat_bindings").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

function pushplusReceiver(binding: any) {
  return String(binding?.pushplus_receiver || binding?.pushplus_to || "").trim();
}

function hasPushChannel(binding: any) {
  return !!(
    (binding?.enabled === true && binding?.wxpusher_uid) ||
    (binding?.pushplus_enabled && pushplusReceiver(binding))
  );
}

function notificationPriority(n: any) {
  const severityRank = n?.severity === "red" ? 0 : n?.severity === "yellow" ? 1 : n?.severity === "green" ? 2 : 3;
  const match = String(n?.content || "").match(/剩余\s*(-?\d+)\s*天/);
  const daysRank = match ? Number(match[1]) : 9999;
  return { severityRank, daysRank };
}

function notificationGroupKey(n: any) {
  const source = String(n?.source_type || "");
  const type = String(n?.type || "");
  const title = String(n?.title || "");
  if (source === "product" || type.startsWith("product") || title.includes("药品")) return "product";
  if (source === "payment" || type.startsWith("payment") || title.includes("医院") || title.includes("回款")) return "payment";
  return "other";
}

function severityText(severity: any) {
  if (severity === "red") return "红灯";
  if (severity === "yellow") return "黄灯";
  if (severity === "green") return "绿灯";
  return "提醒";
}

function cleanNotificationTitle(title: any) {
  return String(title || "")
    .replace(/^药品3天内到期[：:]\s*/, "")
    .replace(/^药品红灯预警[：:]\s*/, "")
    .replace(/^医院回款已到期[：:]\s*/, "")
    .replace(/^医院回款提醒[：:]\s*/, "")
    .trim();
}

function cleanNotificationContent(content: any) {
  return String(content || "").replace(/\s+/g, " ").trim();
}

function buildBatchTitle(kind: string, list: any[]) {
  const red = list.filter((n: any) => n.severity === "red").length;
  const yellow = list.filter((n: any) => n.severity === "yellow").length;
  if (kind === "product") return `药品效期提醒汇总（${list.length}条，红灯${red}条）`;
  if (kind === "payment") return `医院回款提醒汇总（${list.length}条，红灯${red}条，黄灯${yellow}条）`;
  return `系统提醒汇总（${list.length}条）`;
}

function buildBatchContent(kind: string, list: any[]) {
  const label = kind === "product" ? "药品效期" : kind === "payment" ? "医院回款" : "系统";
  const lines = list.slice(0, 20).map((n: any, index: number) => {
    const title = cleanNotificationTitle(n.title);
    const content = cleanNotificationContent(n.content);
    return `${index + 1}. 【${severityText(n.severity)}】${title}\n   ${content}`;
  });
  const more = list.length > 20 ? `\n\n还有 ${list.length - 20} 条未展开，请登录系统查看完整明细。` : "";
  return `本次共有 ${list.length} 条${label}提醒，已按紧急程度排序。\n\n${lines.join("\n")}${more}`;
}

function paymentContactText(p: any) {
  const parts = [`联系人 ${p.contact || "-"}`];
  if (p.role) parts.push(`职务 ${p.role}`);
  if (p.phone) parts.push(paymentPhoneText(p.phone));
  if (p.notes) parts.push(`备注 ${p.notes}`);
  return parts.join(" / ");
}

function dialPhoneValue(phone: any) {
  return String(phone || "").trim().replace(/[^\d+]/g, "");
}

function paymentPhoneText(phone: any) {
  const raw = String(phone || "").trim();
  const dial = dialPhoneValue(raw);
  if (!raw) return "电话 -";
  if (raw.includes("*")) return `电话 ${raw}（号码已打码，请在医院资料里补全）`;
  return dial && dial !== raw ? `电话 ${raw} / 拨号 tel:${dial}` : `电话 ${raw}${dial ? ` / 拨号 tel:${dial}` : ""}`;
}

async function sendOneNotification(admin: any, appToken: string, pushplusToken: string, notification: any, binding: any) {
  let channelSent = 0;
  let channelFailed = 0;
  const patch: Record<string, string | null> = {};
  const receiver = pushplusReceiver(binding);
  if (binding.pushplus_enabled && receiver && !notification.pushplus_sent_at) try {
    if (!pushplusToken) throw new Error("PushPlus 系统发送 Token 未配置");
    await sendPushPlus(pushplusToken, receiver, notification.title || "系统提醒", notification.content || "");
    patch.pushplus_sent_at = new Date().toISOString();
    patch.pushplus_error = null;
    channelSent++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patch.pushplus_error = message;
    channelFailed++;
  }
  if (!channelSent && binding.enabled === true && binding.wxpusher_uid && !notification.wxpusher_sent_at) try {
    if (!appToken) throw new Error("WxPusher 系统 AppToken 未配置");
    await sendWx(appToken, binding.wxpusher_uid, notification.title || "系统提醒", notification.content || "");
    patch.wxpusher_sent_at = new Date().toISOString();
    patch.wxpusher_error = null;
    channelSent++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patch.wxpusher_error = message;
    channelFailed++;
  }
  if (Object.keys(patch).length) await admin.from("notification_events").update(patch).eq("id", notification.id);
  return { ok: channelSent > 0, sent: channelSent > 0 ? 1 : 0, failed: channelSent > 0 ? 0 : (channelFailed > 0 ? 1 : 0), channelSent, channelFailed };
}

async function sendNotificationBatch(admin: any, appToken: string, pushplusToken: string, notifications: any[], binding: any, kind: string) {
  if (!notifications.length) return { ok: true, sent: 0, failed: 0, itemCount: 0 };
  let channelSent = 0;
  let channelFailed = 0;
  const now = new Date().toISOString();
  const patch: Record<string, string | null> = {};
  const ids = notifications.map((n: any) => n.id).filter(Boolean);
  const receiver = pushplusReceiver(binding);
  const title = buildBatchTitle(kind, notifications);
  const content = buildBatchContent(kind, notifications);
  if (binding.pushplus_enabled && receiver) try {
    if (!pushplusToken) throw new Error("PushPlus 系统发送 Token 未配置");
    await sendPushPlus(pushplusToken, receiver, title, content);
    patch.pushplus_sent_at = now;
    patch.pushplus_error = null;
    channelSent++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patch.pushplus_error = message;
    channelFailed++;
  }
  if (!channelSent && binding.enabled === true && binding.wxpusher_uid) try {
    if (!appToken) throw new Error("WxPusher 系统 AppToken 未配置");
    await sendWx(appToken, binding.wxpusher_uid, title, content);
    patch.wxpusher_sent_at = now;
    patch.wxpusher_error = null;
    channelSent++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patch.wxpusher_error = message;
    channelFailed++;
  }
  if (Object.keys(patch).length && ids.length) await admin.from("notification_events").update(patch).in("id", ids);
  return {
    ok: channelSent > 0,
    sent: channelSent > 0 ? 1 : 0,
    failed: channelSent > 0 ? 0 : (channelFailed > 0 ? 1 : 0),
    itemCount: notifications.length,
    channelSent,
    channelFailed,
  };
}

async function pushUserReminders(admin: any, appToken: string, pushplusToken: string, userId: string, limit = 20) {
  const binding = await bindingFor(admin, userId);
  if (!hasPushChannel(binding)) throw new Error("请先在通知中心绑定推送通道");
  const { data, error } = await admin.from("notification_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.max(limit * 6, 100));
  if (error) throw new Error(error.message);
  let sent = 0;
  let failed = 0;
  let itemCount = 0;
  const pending = (data || []).filter((n: any) =>
    !n.wxpusher_sent_at &&
    !n.pushplus_sent_at &&
    !n.wxpusher_error &&
    !n.pushplus_error &&
    hasPushChannel(binding)
  ).sort((a: any, b: any) => {
    const pa = notificationPriority(a);
    const pb = notificationPriority(b);
    if (pa.severityRank !== pb.severityRank) return pa.severityRank - pb.severityRank;
    if (pa.daysRank !== pb.daysRank) return pa.daysRank - pb.daysRank;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
  const groups: Record<string, any[]> = { product: [], payment: [], other: [] };
  for (const n of pending) groups[notificationGroupKey(n)].push(n);
  for (const kind of ["product", "payment"]) {
    const batch = groups[kind].slice(0, limit);
    if (!batch.length) continue;
    const r = await sendNotificationBatch(admin, appToken, pushplusToken, batch, binding, kind);
    sent += r.sent || 0;
    failed += r.failed || 0;
    itemCount += r.itemCount || 0;
  }
  return { sent, failed, itemCount };
}

async function buildDailyNotifications(admin: any) {
  const nowKey = beijingDateKey();
  const slot = reminderSlot();
  const { data: roles } = await admin.from("user_roles").select("user_id,role,trial_ends_at,paid_until");
  const activeUsers = new Set((roles || []).filter(activeOrGrace).map((r: any) => r.user_id));
  const { data: products } = await admin.from("products").select("id,user_id,name,batch,expiry_date,stock,last_month_sales");
  const { data: payments } = await admin.from("payments").select("id,user_id,hospital,next_date,amount,contact,role,phone,notes,paid");
  const rows: any[] = [];
  for (const p of products || []) {
    if (!activeUsers.has(p.user_id)) continue;
    const d = daysUntil(p.expiry_date);
    const m = monthsToExpiry(p.expiry_date);
    const base = `批号 ${p.batch || "-"} / 效期 ${fmtDate(p.expiry_date)} / 库存 ${p.stock || 0} / 月销 ${p.last_month_sales || 0}`;
    if (d >= 0 && d <= 3) rows.push({
      user_id: p.user_id,
      type: "product_urgent",
      severity: "red",
      title: `药品3天内到期：${p.name || ""}`,
      content: `${base} / 剩余 ${d} 天`,
      source_type: "product",
      source_key: p.id,
      dedupe_key: `product:urgent:${p.id}:${nowKey}:${slot}`,
    });
    else if (m <= 3) rows.push({
      user_id: p.user_id,
      type: "product_red",
      severity: "red",
      title: `药品红灯预警：${p.name || ""}`,
      content: base,
      source_type: "product",
      source_key: p.id,
      dedupe_key: `product:red:${p.id}:${nowKey}:${slot}`,
    });
  }
  for (const p of payments || []) {
    if (!activeUsers.has(p.user_id) || p.paid) continue;
    const d = daysUntil(p.next_date);
    if (d <= 7) rows.push({
      user_id: p.user_id,
      type: "payment_due",
      severity: d <= 0 ? "red" : "yellow",
      title: `${d <= 0 ? "医院回款已到期" : "医院回款提醒"}：${p.hospital || ""}`,
      content: `回款日 ${fmtDate(p.next_date)} / 金额 ${Number(p.amount || 0).toLocaleString()} / ${paymentContactText(p)} / 剩余 ${d} 天`,
      source_type: "payment",
      source_key: p.id,
      dedupe_key: `payment:due:${p.id}:${nowKey}:${slot}`,
    });
  }
  if (rows.length) await admin.from("notification_events").upsert(rows, { onConflict: "user_id,dedupe_key" });
  return { created: rows.length, userIds: [...activeUsers], dateKey: nowKey, slot };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceKey) {
    try {
      const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      serviceKey = secretKeys.default || Object.values(secretKeys)[0] || "";
    } catch (_) {
      serviceKey = "";
    }
  }
  const appToken = Deno.env.get("WXPUSHER_APP_TOKEN") || "";
  const pushplusToken = Deno.env.get("PUSHPLUS_TOKEN") || Deno.env.get("PUSHPLUS_APP_TOKEN") || "";
  const pushplusSecretKey = Deno.env.get("PUSHPLUS_SECRET_KEY") || "";
  const missing = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY 或 SUPABASE_SECRET_KEYS");
  if (!appToken && !pushplusToken) missing.push("WXPUSHER_APP_TOKEN 或 PUSHPLUS_TOKEN");
  if (missing.length) return json({ error: `Edge Function 环境变量缺少：${missing.join("、")}` }, 500);

  const admin = createClient(supabaseUrl, serviceKey);
  const requestUrl = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(requestUrl.searchParams.entries());
  const action = String(body.action || "");

  try {
    if (requestUrl.searchParams.get("source") === "pushplus" || action === "pushplus-callback" || body.event === "add_friend") {
      return await handlePushPlusCallback(admin, body);
    }

    if (action === "send-due-reminders") {
      const expected = Deno.env.get("CRON_SECRET") || "";
      if (!expected) return json({ error: "CRON_SECRET 未配置，定时推送已禁用" }, 500);
      if (expected && req.headers.get("x-cron-secret") !== expected) return json({ error: "无权执行定时推送" }, 401);
      const built = await buildDailyNotifications(admin);
      let sent = 0;
      let failed = 0;
      let boundUsers = 0;
      let skippedNoBinding = 0;
      let skippedNotDue = 0;
      let pushedUsers = 0;
      for (const userId of built.userIds) {
        const binding = await bindingFor(admin, userId);
        if (!hasPushChannel(binding)) {
          skippedNoBinding++;
          continue;
        }
        if (!isReminderDueNow(binding)) {
          skippedNotDue++;
          continue;
        }
        boundUsers++;
        const r = await pushUserReminders(admin, appToken, pushplusToken, userId, 20);
        sent += r.sent;
        failed += r.failed;
        if ((r.sent || 0) > 0) pushedUsers++;
      }
      const cleanup = await cleanupOldOperationalData(admin);
      return json({ ok: true, dateKey: built.dateKey, slot: built.slot, activeUsers: built.userIds.length, boundUsers, skippedNoBinding, skippedNotDue, pushedUsers, created: built.created, sent, failed, cleanup });
    }

    const user = await authedUser(req, admin);

    if (action === "phone-login-status") {
      const phone = normalizeCnPhone(body.phone);
      if (!userOwnsVerifiedPhone(user, phone)) return json({ error: "手机号验证码身份不匹配，请重新获取验证码" }, 403);
      const matches = await rolesByPhone(admin, phone);
      const existing = matches.find((r: any) => r.user_id !== user.id);
      return json({
        ok: true,
        legacyPasswordAccount: !!existing,
      });
    }

    if (action === "reset-password-by-phone-proof") {
      const phone = normalizeCnPhone(body.phone);
      const newPassword = String(body.new_password || body.newPassword || "");
      if (!userOwnsVerifiedPhone(user, phone)) return json({ error: "手机号验证码身份不匹配，请重新获取验证码" }, 403);
      if (newPassword.length < 8) return json({ error: "新密码至少 8 位" }, 400);
      const matches = await rolesByPhone(admin, phone);
      const existing = matches.find((r: any) => r.user_id !== user.id) || matches[0];
      const targetUserId = existing?.user_id || user.id;
      const { error } = await admin.auth.admin.updateUserById(targetUserId, { password: newPassword });
      if (error) return json({ error: error.message || "密码重置失败" }, 500);
      return json({ ok: true, resetUserId: targetUserId });
    }

    const role = await userRole(admin, user.id);
    if (!activeOrGrace(role)) return json({ error: "服务已暂停，不能发送微信提醒" }, 403);

    if (action === "reminder-schedule-status") {
      const binding = await bindingFor(admin, user.id);
      return json({ ok: true, ...reminderScheduleStatus(binding) });
    }

    if (action === "pushplus-create-bind-qr") {
      const qr = await createPushPlusBindQr(admin, user.id, pushplusToken, pushplusSecretKey);
      return json({ ok: true, ...qr, callbackUrl: `${requestUrl.origin}${requestUrl.pathname}?source=pushplus` });
    }

    if (action === "pushplus-bind-status") {
      const bindCode = String(body.bind_code || body.bindCode || "").trim();
      if (!bindCode) return json({ error: "缺少绑定码" }, 400);
      const { data: session, error } = await admin.from("pushplus_bind_sessions")
        .select("*")
        .eq("bind_code", bindCode)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) return json({ error: `${error.message}。请先执行最新 PushPlus SQL` }, 500);
      if (!session) return json({ ok: true, bound: false });
      if (new Date(session.expires_at).getTime() < Date.now() && session.status !== "bound") {
        await admin.from("pushplus_bind_sessions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("bind_code", bindCode);
        return json({ ok: true, bound: false, expired: true });
      }
      return json({
        ok: true,
        bound: session.status === "bound",
        expired: false,
        friendNick: session.friend_nick || "",
        expiresAt: session.expires_at,
      });
    }

    if (action === "send-test") {
      const binding = await bindingFor(admin, user.id);
      if (!hasPushChannel(binding)) return json({ error: "请先在通知中心绑定推送通道" }, 400);
      let sent = 0;
      let failed = 0;
      let attempted = false;
      const receiver = pushplusReceiver(binding);
      if (binding.pushplus_enabled && receiver) try {
        attempted = true;
        if (!pushplusToken) throw new Error("PushPlus 系统发送 Token 未配置");
        await sendPushPlus(pushplusToken, receiver, "微信提醒测试", "这是一条来自医药库存动销管理系统的 PushPlus 测试提醒。");
        sent++;
      } catch (_) {
      }
      if (!sent && binding.enabled === true && binding.wxpusher_uid) try {
        attempted = true;
        if (!appToken) throw new Error("WxPusher 系统 AppToken 未配置");
        await sendWx(appToken, binding.wxpusher_uid, "微信提醒测试", "这是一条来自医药库存动销管理系统的 WxPusher 测试提醒。");
        sent++;
      } catch (_) {
      }
      if (attempted && !sent) {
        failed++;
      }
      if (!sent) return json({ error: "没有可用推送通道，请检查 UID/接收令牌、启用状态和 Edge Function Secret" }, 400);
      return json({ ok: true, sent, failed });
    }

    if (action === "send-notification") {
      const id = Number(body.notification_id);
      const binding = await bindingFor(admin, user.id);
      if (!hasPushChannel(binding)) return json({ error: "请先在通知中心绑定推送通道" }, 400);
      const { data: n, error } = await admin.from("notification_events").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (error || !n) return json({ error: "未找到提醒" }, 404);
      const r = await sendOneNotification(admin, appToken, pushplusToken, n, binding);
      if (!r.ok) return json({ error: r.error || "推送失败" }, 500);
      return json({ ok: true, sent: r.sent, failed: r.failed });
    }

    if (action === "push-my-reminders") {
      const result = await pushUserReminders(admin, appToken, pushplusToken, user.id, 20);
      return json({ ok: true, ...result });
    }

    if (action === "clear-read-notifications") {
      const { count, error } = await admin.from("notification_events")
        .delete({ count: "exact" })
        .eq("user_id", user.id)
        .not("read_at", "is", null);
      if (error) return json({ error: `清空失败：${error.message}` }, 500);
      return json({ ok: true, deleted: count || 0 });
    }

    if (action === "clear-logs") {
      const tables = ["inventory_logs", "payment_logs", "delete_logs"];
      let deleted = 0;
      const errors: any[] = [];
      for (const table of tables) {
        const { count, error } = await admin.from(table)
          .delete({ count: "exact" })
          .eq("user_id", user.id);
        if (error) errors.push({ table, error: error.message });
        else deleted += count || 0;
      }
      if (errors.length) return json({ error: `部分日志清空失败：${errors.map((e) => `${e.table}: ${e.error}`).join("；")}`, deleted }, 500);
      return json({ ok: true, deleted });
    }

    if (action === "broadcast-announcement") {
      if (!role || !["admin", "super_admin"].includes(role.role)) return json({ error: "只有管理员可以群发系统更新" }, 403);
      const id = Number(body.announcement_id);
      const { data: announcement } = await admin.from("system_announcements").select("*").eq("id", id).maybeSingle();
      if (!announcement) return json({ error: "未找到系统更新" }, 404);
      const { data: bindings } = await admin.from("wechat_bindings").select("*");
      const { data: roles } = await admin.from("user_roles").select("user_id,role,trial_ends_at,paid_until");
      const roleMap = new Map((roles || []).map((r: any) => [r.user_id, r]));
      let sent = 0;
      let failed = 0;
      for (const b of bindings || []) {
        const targetRole: any = roleMap.get(b.user_id);
        if (!activeOrGrace(targetRole)) continue;
        const target = announcement.target_role || "all";
        const matched = target === "all" || target === targetRole.role || (target === "admin" && ["admin", "super_admin"].includes(targetRole.role));
        if (!matched) continue;
        let delivered = false;
        let attempted = false;
        const receiver = pushplusReceiver(b);
        if (b.pushplus_enabled && receiver) try {
          attempted = true;
          if (!pushplusToken) throw new Error("PushPlus 系统发送 Token 未配置");
          await sendPushPlus(pushplusToken, receiver, announcement.title, announcement.content);
          delivered = true;
          sent++;
        } catch (_) {
        }
        if (!delivered && b.enabled === true && b.wxpusher_uid) try {
          attempted = true;
          if (!appToken) throw new Error("WxPusher 系统 AppToken 未配置");
          await sendWx(appToken, b.wxpusher_uid, announcement.title, announcement.content);
          delivered = true;
          sent++;
        } catch (_) {
        }
        if (attempted && !delivered) {
          failed++;
        }
      }
      return json({ ok: true, sent, failed });
    }

    return json({ error: "未知操作" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("缺少登录授权") || message.includes("登录已过期")) {
      return json({ error: message }, 401);
    }
    return json({ error: message }, 500);
  }
});
