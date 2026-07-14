// Supabase Edge Function: notify-answer
//
// Database Webhook（answersテーブルへのinsert/update）から呼び出される想定。
// 対象メンバー全員の回答が揃ったタイミングでだけ、管理者へ「全員分そろいました」
// メールを1回送る（events.completion_notified_at で二重送信を防ぐ）。
// 回答1件ごとの通知は送らない。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ADMIN_NOTIFY_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "";
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "onboarding@resend.dev";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (WEBHOOK_SECRET) {
    const provided = req.headers.get("x-webhook-secret") ?? "";
    if (provided !== WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  if (!ADMIN_NOTIFY_EMAIL) {
    console.error("ADMIN_NOTIFY_EMAIL is not set");
    return new Response("ADMIN_NOTIFY_EMAIL not configured", { status: 500 });
  }

  const payload = await req.json().catch(() => null);
  const record = payload?.record;
  if (!record?.event_id) {
    return new Response("ignored", { status: 200 });
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("*")
    .eq("id", record.event_id)
    .maybeSingle();

  if (!event) {
    console.error("lookup failed", { eventError, event_id: record.event_id });
    return new Response("event not found", { status: 200 });
  }

  try {
    await maybeNotifyCompletion(event);
  } catch (error) {
    console.error(error);
    return new Response("error sending email", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});

async function maybeNotifyCompletion(event: Record<string, any>) {
  if (event.completion_notified_at) return;

  const { data: members } = await supabase.from("members").select("*");
  const { data: answers } = await supabase.from("answers").select("*").eq("event_id", event.id);
  const { data: targetOverrides } = await supabase
    .from("event_target_members")
    .select("member_id")
    .eq("event_id", event.id);

  const eventDate = event.date ? new Date(event.date) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let eligible: Record<string, any>[];
  if (targetOverrides && targetOverrides.length) {
    const targetIds = new Set(targetOverrides.map((row: Record<string, any>) => row.member_id));
    eligible = (members ?? []).filter((m: Record<string, any>) => targetIds.has(m.id));
  } else {
    eligible = (members ?? []).filter((m: Record<string, any>) => {
      let leaveDate = m.leave_date ? new Date(m.leave_date) : null;
      if (!leaveDate && m.member_state === "退会") leaveDate = today;
      const joinDate = m.join_date ? new Date(m.join_date) : null;
      if (eventDate && joinDate && eventDate < joinDate) return false;
      if (eventDate && leaveDate && eventDate >= leaveDate) return false;
      return true;
    });
  }

  if (!eligible.length) return;

  const allAnswered = eligible.every((m: Record<string, any>) =>
    (answers ?? []).some((a: Record<string, any>) => a.member_id === m.id && a.status && a.status !== "未回答")
  );
  if (!allAnswered) return;

  await sendEmail({
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[若衆] 「${event.name}」の回答が全員分そろいました`,
    text: `「${event.name}」（${event.date}）の出欠回答が対象メンバー全員分そろいました。`,
  });

  await supabase
    .from("events")
    .update({ completion_notified_at: new Date().toISOString() })
    .eq("id", event.id);
}

async function sendEmail({ to, subject, text }: { to: string; subject: string; text: string }) {
  const recipients = to.split(",").map((s) => s.trim()).filter(Boolean);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: recipients,
      subject,
      text,
    }),
  });
  if (!response.ok) {
    console.error("Resend error", response.status, await response.text());
  }
}
