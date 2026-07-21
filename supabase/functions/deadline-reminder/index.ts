// Supabase Edge Function: deadline-reminder
//
// pg_cronから毎日1回呼び出され、回答期限が「明日」の予定のうち、
// まだ未回答のメンバーがいるものを一覧にして管理者へ通知メールを送る
// （メンバー本人への個別リマインドではなく、管理者が声かけできるようにする
// ためのもの）。notify-answerと違い行の変更では起動できない（日付ベースの
// 判定のため）ので、pg_cron + pg_net による時刻起動を想定する
// （--no-verify-jwtでデプロイし、x-webhook-secretヘッダーで認可する）。
//
// 対象メンバー・未回答判定のロジックはnotify-answerの「全員回答完了」判定と
// 同じ考え方（event_target_membersがあればそれを対象、無ければ在籍期間から
// 自動判定）。送信はnotify-answerと同じくResend・ADMIN_NOTIFY_EMAIL宛て
// （Resendは送信ドメイン未認証のためこの宛先以外には送れないが、管理者1人に
// 送るだけなのでこれで足りる）。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ADMIN_NOTIFY_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "";
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "onboarding@resend.dev";
const CRON_SECRET = Deno.env.get("DEADLINE_REMINDER_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (CRON_SECRET) {
    const provided = req.headers.get("x-webhook-secret") ?? "";
    if (provided !== CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  if (!ADMIN_NOTIFY_EMAIL) {
    console.error("ADMIN_NOTIFY_EMAIL is not set");
    return new Response("ADMIN_NOTIFY_EMAIL not configured", { status: 500 });
  }

  try {
    const notifiedCount = await sendDeadlineReminder();
    return new Response(JSON.stringify({ ok: true, events: notifiedCount }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    return new Response("error sending reminder", { status: 500 });
  }
});

// サーバーはUTCで動くが、期限は日本のカレンダー日なので、
// 「JSTでの今日」を起点に日付文字列を計算する。
function jstDateString(offsetDays = 0): string {
  const ms = Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function getEligibleMembers(event: Record<string, any>, members: Record<string, any>[]) {
  const { data: overrides } = await supabase
    .from("event_target_members")
    .select("member_id")
    .eq("event_id", event.id);

  if (overrides && overrides.length) {
    const targetIds = new Set(overrides.map((row: Record<string, any>) => row.member_id));
    return members.filter((m: Record<string, any>) => targetIds.has(m.id));
  }

  const eventDate = event.date ? new Date(event.date) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return members.filter((m: Record<string, any>) => {
    let leaveDate = m.leave_date ? new Date(m.leave_date) : null;
    if (!leaveDate && m.member_state === "退会") leaveDate = today;
    const joinDate = m.join_date ? new Date(m.join_date) : null;
    if (eventDate && joinDate && eventDate < joinDate) return false;
    if (eventDate && leaveDate && eventDate >= leaveDate) return false;
    return true;
  });
}

async function sendDeadlineReminder(): Promise<number> {
  const targetDeadline = jstDateString(1);

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select("*")
    .eq("public_state", "公開")
    .eq("answer_deadline", targetDeadline)
    .is("reminder_sent_at", null);

  if (eventsError) throw eventsError;
  if (!events || !events.length) return 0;

  const { data: members } = await supabase.from("members").select("*");
  const summaries: { event: Record<string, any>; unansweredNames: string[] }[] = [];

  for (const event of events) {
    const eligible = await getEligibleMembers(event, members ?? []);
    const { data: answers } = await supabase.from("answers").select("*").eq("event_id", event.id);

    const unanswered = eligible.filter((m: Record<string, any>) =>
      !(answers ?? []).some((a: Record<string, any>) => a.member_id === m.id && a.status && a.status !== "未回答")
    );

    if (unanswered.length) {
      summaries.push({ event, unansweredNames: unanswered.map((m: Record<string, any>) => m.name) });
    }

    // 未回答が0人でも、同じ予定を明日また処理しないよう記録する
    await supabase.from("events").update({ reminder_sent_at: new Date().toISOString() }).eq("id", event.id);
  }

  if (!summaries.length) return 0;

  const lines = summaries.map(({ event, unansweredNames }) =>
    `・${event.name}（${event.date}）\n  未回答：${unansweredNames.join('、')}`
  );

  await sendEmail({
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[若衆] 回答期限が明日の予定があります（${summaries.length}件）`,
    text: `以下の予定の回答期限が明日までです。未回答のメンバーへの声かけをお願いします。\n\n${lines.join("\n\n")}`,
  });

  return summaries.length;
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
