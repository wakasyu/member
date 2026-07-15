// Supabase Edge Function: register-member
//
// 管理者が発行した招待リンク（?register=トークン）から、ログイン不要で
// 新しい人が自分の名前・連絡先・メールアドレスを入力するだけで、
// メンバー登録とアカウント作成まで完了できるようにするための公開エンドポイント。
// 事前に管理者がメンバー行を作っておく必要はなく、この関数が
// membersテーブルの行そのものを新規作成する。
// service_role権限が必要な auth.admin.createUser をクライアントから
// 直接呼ばせるわけにはいかないため、その処理をここに閉じ込める。
//
// 認証はJWTではなく、トークン自体（推測不可能な長いランダム文字列で
// 1回だけ有効）で行う。招待されていない相手はmember_invitesテーブルの
// tokenが一致しないため何もできない。
//
// GET  ?token=xxx  … 招待の有効性確認用
// POST { token, email, name, shortName, contact, birthDate, costumeSize, tshirtSize }
//      … メンバー行の新規作成＋アカウント作成

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_PASSWORD = "password";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "onboarding@resend.dev";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// 登録メール送信に失敗しても登録自体は完了させたいので、呼び出し側では
// awaitするが例外は投げない（内部でcatchする）。
// 注意：Resendは送信ドメイン未認証だと、アカウントの登録メール以外には
// 送信できない制限があるため、実際に本人へ届くかはドメイン認証状況に依存する。
async function sendWelcomeEmail(to: string, name: string) {
  if (!RESEND_API_KEY) return;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject: "[若衆] 登録が完了しました！",
        text: `${name}さん\n\n登録が完了しました！これから若衆として一緒に頑張っていきましょう！\n\n下記でログインできます。\nメールアドレス：${to}\nパスワード：password\n\n※ログイン後、パスワードは必ず変更してください。`,
      }),
    });
    if (!response.ok) {
      console.error("welcome email failed", response.status, await response.text());
    }
  } catch (error) {
    console.error("welcome email error", error);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  if (req.method === "GET") {
    const token = (url.searchParams.get("token") || "").trim();
    if (!token) return jsonResponse({ error: "招待リンクが正しくありません。" }, 400);

    const { data: invite } = await supabase
      .from("member_invites")
      .select("used_at")
      .eq("token", token)
      .maybeSingle();

    if (!invite) return jsonResponse({ error: "招待リンクが無効です。管理者に確認してください。" }, 400);
    if (invite.used_at) return jsonResponse({ error: "このリンクはすでに登録済みです。" }, 400);
    return jsonResponse({ ok: true });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "unsupported method" }, 405);
  }

  const payload = await req.json().catch(() => null);
  const token = String(payload?.token || "").trim();
  const email = String(payload?.email || "").trim().toLowerCase();
  const name = String(payload?.name || "").trim();

  if (!token) return jsonResponse({ error: "招待リンクが正しくありません。" }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "メールアドレスを正しく入力してください。" }, 400);
  }
  if (!name) return jsonResponse({ error: "氏名を入力してください。" }, 400);

  const contact = payload?.contact != null ? String(payload.contact).trim() : "";
  if (contact && !/^[0-9]{2,4}-[0-9]{2,4}-[0-9]{3,4}$/.test(contact)) {
    return jsonResponse({ error: "電話番号は「090-1234-5678」のようにハイフン区切りで入力してください。" }, 400);
  }

  const { data: invite } = await supabase
    .from("member_invites")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (!invite) return jsonResponse({ error: "招待リンクが無効です。管理者に確認してください。" }, 400);
  if (invite.used_at) return jsonResponse({ error: "このリンクはすでに登録済みです。" }, 400);

  const { data: member, error: memberError } = await supabase
    .from("members")
    .insert({
      name,
      short_name: payload?.shortName != null ? String(payload.shortName).trim() : "",
      contact,
      birth_date: payload?.birthDate || null,
      costume_size: payload?.costumeSize != null ? String(payload.costumeSize).trim() : "",
      tshirt_size: payload?.tshirtSize != null ? String(payload.tshirtSize).trim() : "",
    })
    .select()
    .single();

  if (memberError || !member) {
    const message = (memberError?.message || "").toLowerCase().includes("duplicate")
      ? "同じ名前のメンバーが既に登録されています。管理者に確認してください。"
      : `メンバー登録に失敗しました：${memberError?.message || "unknown error"}`;
    return jsonResponse({ error: message }, 400);
  }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password: DEFAULT_PASSWORD,
    email_confirm: true,
  });

  if (createError || !created?.user) {
    // アカウント作成に失敗した場合、作りかけのメンバー行を残さない
    await supabase.from("members").delete().eq("id", member.id);
    const message = (createError?.message || "").toLowerCase().includes("already")
      ? "このメールアドレスはすでに登録されています。"
      : `アカウント作成に失敗しました：${createError?.message || "unknown error"}`;
    return jsonResponse({ error: message }, 400);
  }

  const { error: profileError } = await supabase.from("profiles").insert({
    id: created.user.id,
    display_name: String(payload?.shortName || name),
    role: "member",
    member_id: member.id,
  });

  if (profileError) {
    return jsonResponse({ error: `プロフィール作成に失敗しました：${profileError.message}` }, 500);
  }

  await supabase
    .from("member_invites")
    .update({ used_at: new Date().toISOString(), created_member_id: member.id })
    .eq("id", invite.id);

  await supabase.from("logs").insert({
    action: "メンバー本人登録",
    member_id: member.id,
    member_name: name,
    detail: `email: ${email}`,
  });

  await sendWelcomeEmail(email, name);

  return jsonResponse({ ok: true });
});
