// Supabase Edge Function: deadline-reminder
//
// pg_cronから毎日1回呼び出され、回答期限が「明日」の予定・日程アンケートの
// うち、まだ未回答のメンバーがいるものを一覧にして管理者へ通知メールを送る
// （メンバー本人への個別リマインドではなく、管理者が声かけできるようにする
// ためのもの）。notify-answerと違い行の変更では起動できない（日付ベースの
// 判定のため）ので、pg_cron + pg_net による時刻起動を想定する
// （--no-verify-jwtでデプロイし、x-webhook-secretヘッダーで認可する）。
//
// 予定側の対象メンバー・未回答判定のロジックはnotify-answerの
// 「全員回答完了」判定と同じ考え方（event_target_membersがあればそれを対象、
// 無ければ在籍期間から自動判定）。日程アンケートには対象者を絞る仕組みが
// 無いため、在籍中の全メンバーを対象とし、「空き時間の申告（slots）または
// 備考（notes）のどちらも無い」ことをもって未回答とみなす（0件の空き時間
// そのものが「その期間は全部埋まっている」という意思表示である可能性を
// 区別できないため、備考だけでも書いてあれば回答済み扱いにする）。
// 送信はnotify-answerと同じくResend・ADMIN_NOTIFY_EMAIL宛て
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
    const result = await sendDeadlineReminder();
    return new Response(JSON.stringify({ ok: true, ...result }), {
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

async function getEligibleMembersForEvent(event: Record<string, any>, members: Record<string, any>[]) {
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

async function collectEventSummaries(targetDeadline: string, members: Record<string, any>[]) {
  const { data: events, error } = await supabase
    .from("events")
    .select("*")
    .eq("public_state", "公開")
    .eq("answer_deadline", targetDeadline)
    .is("reminder_sent_at", null);

  if (error) throw error;
  if (!events || !events.length) return [];

  const summaries: { event: Record<string, any>; unansweredNames: string[] }[] = [];

  for (const event of events) {
    const eligible = await getEligibleMembersForEvent(event, members);
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

  return summaries;
}

async function collectPollSummaries(targetDeadline: string, members: Record<string, any>[]) {
  const { data: polls, error } = await supabase
    .from("availability_polls")
    .select("*")
    .eq("public_state", "公開")
    .eq("answer_deadline", targetDeadline)
    .is("reminder_sent_at", null);

  if (error) throw error;
  if (!polls || !polls.length) return [];

  const eligible = members.filter((m: Record<string, any>) => m.member_state !== "退会");
  const summaries: { poll: Record<string, any>; unansweredNames: string[] }[] = [];

  for (const poll of polls) {
    const [{ data: slots }, { data: notes }] = await Promise.all([
      supabase.from("availability_slots").select("member_id").eq("poll_id", poll.id),
      supabase.from("availability_notes").select("member_id, note").eq("poll_id", poll.id),
    ]);

    const answeredIds = new Set<string>();
    (slots ?? []).forEach((row: Record<string, any>) => answeredIds.add(row.member_id));
    (notes ?? []).forEach((row: Record<string, any>) => {
      if (row.note && String(row.note).trim()) answeredIds.add(row.member_id);
    });

    const unanswered = eligible.filter((m: Record<string, any>) => !answeredIds.has(m.id));

    if (unanswered.length) {
      summaries.push({ poll, unansweredNames: unanswered.map((m: Record<string, any>) => m.name) });
    }

    // 未回答が0人でも、同じ日程アンケートを明日また処理しないよう記録する
    await supabase.from("availability_polls").update({ reminder_sent_at: new Date().toISOString() }).eq("id", poll.id);
  }

  return summaries;
}

async function sendDeadlineReminder(): Promise<{ events: number; polls: number }> {
  const targetDeadline = jstDateString(1);
  const { data: members } = await supabase.from("members").select("*");

  const eventSummaries = await collectEventSummaries(targetDeadline, members ?? []);
  const pollSummaries = await collectPollSummaries(targetDeadline, members ?? []);

  if (!eventSummaries.length && !pollSummaries.length) return { events: 0, polls: 0 };

  const sections: string[] = [];
  if (eventSummaries.length) {
    const lines = eventSummaries.map(({ event, unansweredNames }) =>
      `・${event.name}（${event.date}）\n  未回答：${unansweredNames.join("、")}`
    );
    sections.push(`【予定】\n${lines.join("\n\n")}`);
  }
  if (pollSummaries.length) {
    const lines = pollSummaries.map(({ poll, unansweredNames }) =>
      `・${poll.title}\n  未回答：${unansweredNames.join("、")}`
    );
    sections.push(`【日程アンケート】\n${lines.join("\n\n")}`);
  }

  const totalCount = eventSummaries.length + pollSummaries.length;
  await sendEmail({
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[若衆] 回答期限が明日のものがあります（${totalCount}件）`,
    text: `以下の回答期限が明日までです。未回答のメンバーへの声かけをお願いします。\n\n${sections.join("\n\n")}`,
  });

  return { events: eventSummaries.length, polls: pollSummaries.length };
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
