import { createClient } from "npm:@supabase/supabase-js@2";

type JsonMap = Record<string, unknown>;

let pushplusAccessKey = "";
let pushplusAccessKeyUntil = 0;

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

async function getPushPlusAccessKey(token: string, secretKey: string) {
  if (!token) throw new Error("PushPlus 绯荤粺鍙戦€?Token 鏈厤缃?);
  if (!secretKey) throw new Error("PushPlus SecretKey 鏈厤缃紝璇峰湪 Supabase Secrets 娣诲姞 PUSHPLUS_SECRET_KEY");
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
  url.searchParams.set("scanCount", "999999999");
  
  const res = await fetch(url.toString(), { headers: { "access-key": accessKey } });
  const data = await res.json().catch(() => ({}));
  const qrCodeImgUrl = data.data?.qrCodeImgUrl || data.data?.qrCode || data.data?.url || "";
  if (!res.ok || data.code !== 200 || !qrCodeImgUrl) {
    throw new Error(data.msg || data.message || `PushPlus 浜岀淮鐮佺敓鎴愬け璐?HTTP ${res.status}`);
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
  if (error) throw new Error(`${error.message}銆傝鍏堟墽琛屾渶鏂?PushPlus SQL`);
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
  if (!jwt) throw new Error("缂哄皯鐧诲綍鎺堟潈");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) throw new Error("鐧诲綍宸茶繃鏈燂紝璇烽噸鏂扮櫥褰?);
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
    if (!appToken) throw new Error("WxPusher 绯荤粺 AppToken 鏈厤缃?);
    await sendWx(appToken, binding.wxpusher_uid, notification.title || "绯荤粺鎻愰啋", notification.content || "");
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
    if (!pushplusToken) throw new Error("PushPlus 绯荤粺鍙戦€?Token 鏈厤缃?);
    await sendPushPlus(pushplusToken, receiver, notification.title || "绯荤粺鎻愰啋", notification.content || "");
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
  if (!hasPushChannel(binding)) throw new Error("璇峰厛鍦ㄩ€氱煡涓績缁戝畾鎺ㄩ€侀€氶亾");
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
    const base = `鎵瑰彿 ${p.batch || "-"} / 鏁堟湡 ${fmtDate(p.expiry_date)} / 搴撳瓨 ${p.stock || 0} / 鏈堥攢 ${p.last_month_sales || 0}`;
    if (m <= 3) rows.push({
      user_id: p.user_id,
      type: "product_red",
      severity: "red",
      title: `鑽搧绾㈢伅棰勮锛?{p.name || ""}`,
      content: base,
      source_type: "product",
      source_key: p.id,
      dedupe_key: `product:red:${p.id}:${nowKey}`,
    });
    if (d >= 0 && d <= 3) rows.push({
      user_id: p.user_id,
      type: "product_urgent",
      severity: "red",
      title: `鑽搧3澶╁唴鍒版湡锛?{p.name || ""}`,
      content: `${base} / 鍓╀綑 ${d} 澶ー,
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
      title: `${d <= 0 ? "鍖婚櫌鍥炴宸插埌鏈? : "鍖婚櫌鍥炴鎻愰啋"}锛?{p.hospital || ""}`,
      content: `鍥炴鏃?${fmtDate(p.next_date)} / 閲戦 ${Number(p.amount || 0).toLocaleString()} / 鑱旂郴浜?${p.contact || "-"} / 鍓╀綑 ${d} 澶ー,
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
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY 鎴?SUPABASE_SECRET_KEYS");
  if (!appToken && !pushplusToken) missing.push("WXPUSHER_APP_TOKEN 鎴?PUSHPLUS_TOKEN");
  if (missing.length) return json({ error: `Edge Function 鐜鍙橀噺缂哄皯锛?{missing.join("銆?)}` }, 500);

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
      if (!expected) return json({ error: "CRON_SECRET 鏈厤缃紝瀹氭椂鎺ㄩ€佸凡绂佺敤" }, 500);
      if (expected && req.headers.get("x-cron-secret") !== expected) return json({ error: "鏃犳潈鎵ц瀹氭椂鎺ㄩ€? }, 401);
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
    if (!activeOrGrace(role)) return json({ error: "鏈嶅姟宸叉殏鍋滐紝涓嶈兘鍙戦€佸井淇℃彁閱? }, 403);

    if (action === "pushplus-create-bind-qr") {
      const qr = await createPushPlusBindQr(admin, user.id, pushplusToken, pushplusSecretKey);
      return json({ ok: true, ...qr, callbackUrl: `${requestUrl.origin}${requestUrl.pathname}?source=pushplus` });
    }

    if (action === "pushplus-bind-status") {
      const bindCode = String(body.bind_code || body.bindCode || "").trim();
      if (!bindCode) return json({ error: "缂哄皯缁戝畾鐮? }, 400);
      const { data: session, error } = await admin.from("pushplus_bind_sessions")
        .select("*")
        .eq("bind_code", bindCode)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) return json({ error: `${error.message}銆傝鍏堟墽琛屾渶鏂?PushPlus SQL` }, 500);
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
      if (!hasPushChannel(binding)) return json({ error: "璇峰厛鍦ㄩ€氱煡涓績缁戝畾鎺ㄩ€侀€氶亾" }, 400);
      let sent = 0;
      let failed = 0;
      if (binding.enabled !== false && binding.wxpusher_uid) try {
        if (!appToken) throw new Error("WxPusher 绯荤粺 AppToken 鏈厤缃?);
        await sendWx(appToken, binding.wxpusher_uid, "寰俊鎻愰啋娴嬭瘯", "杩欐槸涓€鏉℃潵鑷尰鑽簱瀛樺姩閿€绠＄悊绯荤粺鐨?WxPusher 娴嬭瘯鎻愰啋銆?);
        sent++;
      } catch (_) {
        failed++;
      }
      const receiver = pushplusReceiver(binding);
      if (binding.pushplus_enabled && receiver) try {
        if (!pushplusToken) throw new Error("PushPlus 绯荤粺鍙戦€?Token 鏈厤缃?);
        await sendPushPlus(pushplusToken, receiver, "寰俊鎻愰啋娴嬭瘯", "杩欐槸涓€鏉℃潵鑷尰鑽簱瀛樺姩閿€绠＄悊绯荤粺鐨?PushPlus 娴嬭瘯鎻愰啋銆?);
        sent++;
      } catch (_) {
        failed++;
      }
      if (!sent) return json({ error: "娌℃湁鍙敤鎺ㄩ€侀€氶亾锛岃妫€鏌?UID/鎺ユ敹浠ょ墝銆佸惎鐢ㄧ姸鎬佸拰 Edge Function Secret" }, 400);
      return json({ ok: true, sent, failed });
    }

    if (action === "send-notification") {
      const id = Number(body.notification_id);
      const binding = await bindingFor(admin, user.id);
      if (!hasPushChannel(binding)) return json({ error: "璇峰厛鍦ㄩ€氱煡涓績缁戝畾鎺ㄩ€侀€氶亾" }, 400);
      const { data: n, error } = await admin.from("notification_events").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (error || !n) return json({ error: "鏈壘鍒版彁閱? }, 404);
      const r = await sendOneNotification(admin, appToken, pushplusToken, n, binding);
      if (!r.ok) return json({ error: r.error || "鎺ㄩ€佸け璐? }, 500);
      return json({ ok: true, sent: r.sent, failed: r.failed });
    }

    if (action === "push-my-reminders") {
      const result = await pushUserReminders(admin, appToken, pushplusToken, user.id, 20);
      return json({ ok: true, ...result });
    }

    if (action === "broadcast-announcement") {
      if (!role || !["admin", "super_admin"].includes(role.role)) return json({ error: "鍙湁绠＄悊鍛樺彲浠ョ兢鍙戠郴缁熸洿鏂? }, 403);
      const id = Number(body.announcement_id);
      const { data: announcement } = await admin.from("system_announcements").select("*").eq("id", id).maybeSingle();
      if (!announcement) return json({ error: "鏈壘鍒扮郴缁熸洿鏂? }, 404);
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
          if (!appToken) throw new Error("WxPusher 绯荤粺 AppToken 鏈厤缃?);
          await sendWx(appToken, b.wxpusher_uid, announcement.title, announcement.content);
          sent++;
        } catch (_) {
          failed++;
        }
        const receiver = pushplusReceiver(b);
        if (b.pushplus_enabled && receiver) try {
          if (!pushplusToken) throw new Error("PushPlus 绯荤粺鍙戦€?Token 鏈厤缃?);
          await sendPushPlus(pushplusToken, receiver, announcement.title, announcement.content);
          sent++;
        } catch (_) {
          failed++;
        }
      }
      return json({ ok: true, sent, failed });
    }

    return json({ error: "鏈煡鎿嶄綔" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

