import { createClient } from "npm:@supabase/supabase-js@2";

type JsonMap = Record<string, unknown>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: JsonMap, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function daysUntil(dateText: string) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(dateText).getTime() - now.getTime()) / 86400000);
}

function monthsToExpiry(dateText: string) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return (new Date(dateText).getTime() - now.getTime()) / 2678400000;
}

function fmtDate(value: string) {
  if (!value) return "-";
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

async function bindingFor(admin: any, userId: string) {
  const { data } = await admin.from("wechat_bindings").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

function pushplusReceiver(binding: any) {
  return String(binding?.pushplus_receiver || binding?.pushplus_to || "").trim();
}

function hasPushChannel(binding: any) {
  return !!(
    (binding?.enabled !== false && binding?.wxpusher_uid) ||
    (binding?.pushplus_enabled && pushplusReceiver(binding))
  );
}

async function sendOneNotification(admin: any, appToken: string, pushplusToken: string, notification: any, binding: any) {
  let sent = 0;
  let failed = 0;
  const patch: Record<string, string | null> = {};
  if (binding.enabled !== false && binding.wxpusher_uid && !notification.wxpusher_sent_at) try {
    if (!appToken) throw new Error("WxPusher 系统 AppToken 未配置");
    await sendWx(appToken, binding.wxpusher_uid, notification.title || "系统提醒", notification.content || "");
    patch.wxpusher_sent_at = new Date().toISOString();
    patch.wxpusher_error = null;
    sent++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patch.wxpusher_error = message;
    failed++;
  }
  const receiver = pushplusReceiver(binding);
  if (binding.pushplus_enabled && receiver && !notification.pushplus_sent_at) try {
    if (!pushplusToken) throw new Error("PushPlus 系统发送 Token 未配置");
    await sendPushPlus(pushplusToken, receiver, notification.title || "系统提醒", notification.content || "");
    patch.pushplus_sent_at = new Date().toISOString();
    patch.pushplus_error = null;
    sent++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patch.pushplus_error = message;
    failed++;
  }
  if (Object.keys(patch).length) await admin.from("notification_events").update(patch).eq("id", notification.id);
  return { ok: sent > 0, sent, failed };
}

async function pushUserReminders(admin: any, appToken: string, pushplusToken: string, userId: string, limit = 20) {
  const binding = await bindingFor(admin, userId);
  if (!hasPushChannel(binding)) throw new Error("请先在通知中心绑定推送通道");
  const { data, error } = await admin.from("notification_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit * 2);
  if (error) throw new Error(error.message);
  let sent = 0;
  let failed = 0;
  const pending = (data || []).filter((n: any) =>
    (binding.enabled !== false && binding.wxpusher_uid && !n.wxpusher_sent_at) ||
    (binding.pushplus_enabled && pushplusReceiver(binding) && !n.pushplus_sent_at)
  ).slice(0, limit);
  for (const n of pending) {
    const r = await sendOneNotification(admin, appToken, pushplusToken, n, binding);
    sent += r.sent || 0;
    failed += r.failed || 0;
  }
  return { sent, failed };
}

async function buildDailyNotifications(admin: any) {
  const nowKey = new Date().toISOString().slice(0, 10);
  const { data: roles } = await admin.from("user_roles").select("user_id,role,trial_ends_at,paid_until");
  const activeUsers = new Set((roles || []).filter(activeOrGrace).map((r: any) => r.user_id));
  const { data: products } = await admin.from("products").select("id,user_id,name,batch,expiry_date,stock,last_month_sales");
  const { data: payments } = await admin.from("payments").select("id,user_id,hospital,next_date,amount,contact,paid");
  const rows: any[] = [];
  for (const p of products || []) {
    if (!activeUsers.has(p.user_id)) continue;
    const d = daysUntil(p.expiry_date);
    const m = monthsToExpiry(p.expiry_date);
    const base = `批号 ${p.batch || "-"} / 效期 ${fmtDate(p.expiry_date)} / 库存 ${p.stock || 0} / 月销 ${p.last_month_sales || 0}`;
    if (m <= 3) rows.push({
      user_id: p.user_id,
      type: "product_red",
      severity: "red",
      title: `药品红灯预警：${p.name || ""}`,
      content: base,
      source_type: "product",
      source_key: p.id,
      dedupe_key: `product:red:${p.id}:${nowKey}`,
    });
    if (d >= 0 && d <= 3) rows.push({
      user_id: p.user_id,
      type: "product_urgent",
      severity: "red",
      title: `药品3天内到期：${p.name || ""}`,
      content: `${base} / 剩余 ${d} 天`,
      source_type: "product",
      source_key: p.id,
      dedupe_key: `product:urgent:${p.id}:${nowKey}`,
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
      content: `回款日 ${fmtDate(p.next_date)} / 金额 ${Number(p.amount || 0).toLocaleString()} / 联系人 ${p.contact || "-"} / 剩余 ${d} 天`,
      source_type: "payment",
      source_key: p.id,
      dedupe_key: `payment:due:${p.id}:${nowKey}`,
    });
  }
  if (rows.length) await admin.from("notification_events").upsert(rows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true });
  return { created: rows.length, userIds: [...activeUsers] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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
  const missing = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY 或 SUPABASE_SECRET_KEYS");
  if (!appToken && !pushplusToken) missing.push("WXPUSHER_APP_TOKEN 或 PUSHPLUS_TOKEN");
  if (missing.length) return json({ error: `Edge Function 环境变量缺少：${missing.join("、")}` }, 500);

  const admin = createClient(supabaseUrl, serviceKey);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    if (action === "send-due-reminders") {
      const expected = Deno.env.get("CRON_SECRET") || "";
      if (!expected) return json({ error: "CRON_SECRET 未配置，定时推送已禁用" }, 500);
      if (expected && req.headers.get("x-cron-secret") !== expected) return json({ error: "无权执行定时推送" }, 401);
      const built = await buildDailyNotifications(admin);
      let sent = 0;
      let failed = 0;
      for (const userId of built.userIds) {
        const binding = await bindingFor(admin, userId);
        if (!hasPushChannel(binding)) continue;
        const r = await pushUserReminders(admin, appToken, pushplusToken, userId, 20);
        sent += r.sent;
        failed += r.failed;
      }
      return json({ ok: true, created: built.created, sent, failed });
    }

    const user = await authedUser(req, admin);
    const role = await userRole(admin, user.id);
    if (!activeOrGrace(role)) return json({ error: "服务已暂停，不能发送微信提醒" }, 403);

    if (action === "send-test") {
      const binding = await bindingFor(admin, user.id);
      if (!hasPushChannel(binding)) return json({ error: "请先在通知中心绑定推送通道" }, 400);
      let sent = 0;
      let failed = 0;
      if (binding.enabled !== false && binding.wxpusher_uid) try {
        if (!appToken) throw new Error("WxPusher 系统 AppToken 未配置");
        await sendWx(appToken, binding.wxpusher_uid, "微信提醒测试", "这是一条来自医药库存动销管理系统的 WxPusher 测试提醒。");
        sent++;
      } catch (_) {
        failed++;
      }
      const receiver = pushplusReceiver(binding);
      if (binding.pushplus_enabled && receiver) try {
        if (!pushplusToken) throw new Error("PushPlus 系统发送 Token 未配置");
        await sendPushPlus(pushplusToken, receiver, "微信提醒测试", "这是一条来自医药库存动销管理系统的 PushPlus 测试提醒。");
        sent++;
      } catch (_) {
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
        if (b.enabled !== false && b.wxpusher_uid) try {
          if (!appToken) throw new Error("WxPusher 系统 AppToken 未配置");
          await sendWx(appToken, b.wxpusher_uid, announcement.title, announcement.content);
          sent++;
        } catch (_) {
          failed++;
        }
        const receiver = pushplusReceiver(b);
        if (b.pushplus_enabled && receiver) try {
          if (!pushplusToken) throw new Error("PushPlus 系统发送 Token 未配置");
          await sendPushPlus(pushplusToken, receiver, announcement.title, announcement.content);
          sent++;
        } catch (_) {
          failed++;
        }
      }
      return json({ ok: true, sent, failed });
    }

    return json({ error: "未知操作" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
