// Supabase Edge Function: notify-answer
//
// Database Webhook（answers / availability_slots / availability_notes への
// insert・update）から呼び出される想定。対象メンバー全員の回答が揃った
// タイミングでだけ、管理者へ「全員分そろいました」メールを1回送る
// （events.completion_notified_at / availability_polls.completion_notified_at
// で二重送信を防ぐ）。回答1件ごとの通知は送らない。
//
// どのテーブルからの呼び出しかはpayload.table（supabase_functions.http_request
// が自動で付与するTG_TABLE_NAME）で判定する。

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
  const table = payload?.table;
  const record = payload?.record;

  try {
    if (table === "availability_slots" || table === "availability_notes") {
      if (!record?.poll_id) return new Response("ignored", { status: 200 });
      await maybeNotifyPollCompletion(record.poll_id);
    } else {
      if (!record?.event_id) return new Response("ignored", { status: 200 });

      const { data: event, error: eventError } = await supabase
        .from("events")
        .select("*")
        .eq("id", record.event_id)
        .maybeSingle();

      if (!event) {
        console.error("lookup failed", { eventError, event_id: record.event_id });
        return new Response("event not found", { status: 200 });
      }

      await maybeNotifyCompletion(event);
    }
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

// 日程アンケートには対象者を絞る仕組みが無いため在籍中の全メンバーが対象。
// deadline-reminderの未回答判定と同じく「空き時間（slots）も備考（notes）も
// どちらも無い」ことをもって未回答とみなす。
async function maybeNotifyPollCompletion(pollId: string) {
  const { data: poll } = await supabase
    .from("availability_polls")
    .select("*")
    .eq("id", pollId)
    .maybeSingle();

  if (!poll || poll.completion_notified_at || poll.public_state === "削除") return;

  const { data: members } = await supabase.from("members").select("*");
  const eligible = (members ?? []).filter((m: Record<string, any>) => m.member_state !== "退会");
  if (!eligible.length) return;

  const [{ data: slots }, { data: notes }] = await Promise.all([
    supabase.from("availability_slots").select("member_id").eq("poll_id", pollId),
    supabase.from("availability_notes").select("member_id, note").eq("poll_id", pollId),
  ]);

  const answeredIds = new Set<string>();
  (slots ?? []).forEach((row: Record<string, any>) => answeredIds.add(row.member_id));
  (notes ?? []).forEach((row: Record<string, any>) => {
    if (row.note && String(row.note).trim()) answeredIds.add(row.member_id);
  });

  const allAnswered = eligible.every((m: Record<string, any>) => answeredIds.has(m.id));
  if (!allAnswered) return;

  await sendEmail({
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[若衆] 日程アンケート「${poll.title}」の回答が全員分そろいました`,
    text: `日程アンケート「${poll.title}」への回答が対象メンバー全員分そろいました。`,
  });

  await supabase
    .from("availability_polls")
    .update({ completion_notified_at: new Date().toISOString() })
    .eq("id", pollId);
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
