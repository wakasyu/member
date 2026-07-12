// Supabase Edge Function: register-member
//
// 管理者が発行した招待リンク（?register=トークン）から、ログイン不要で
// 新メンバー本人がメールアドレスと基本情報を入力し、アカウント作成まで
// 完了できるようにするための公開エンドポイント。
// service_role権限が必要な auth.admin.createUser をクライアントから
// 直接呼ばせるわけにはいかないため、その処理をここに閉じ込める。
//
// 認証はJWTではなく、トークン自体（推測不可能な長いランダム文字列で
// 1回だけ有効）で行う。招待されていない相手はmembersテーブルの
// registration_tokenが一致しないため何もできない。
//
// GET  ?token=xxx  … 招待の有効性確認＋氏名のプレフィル用
// POST { token, email, name, shortName, contact, birthDate, costumeSize, tshirtSize }
//      … アカウント作成＋メンバー情報反映

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_PASSWORD = "password";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

    const { data: member } = await supabase
      .from("members")
      .select("name, registered_at")
      .eq("registration_token", token)
      .maybeSingle();

    if (!member) return jsonResponse({ error: "招待リンクが無効です。管理者に確認してください。" }, 400);
    if (member.registered_at) return jsonResponse({ error: "このリンクはすでに登録済みです。" }, 400);
    return jsonResponse({ name: member.name || "" });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "unsupported method" }, 405);
  }

  const payload = await req.json().catch(() => null);
  const token = String(payload?.token || "").trim();
  const email = String(payload?.email || "").trim().toLowerCase();

  if (!token) return jsonResponse({ error: "招待リンクが正しくありません。" }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "メールアドレスを正しく入力してください。" }, 400);
  }

  const { data: member } = await supabase
    .from("members")
    .select("*")
    .eq("registration_token", token)
    .maybeSingle();

  if (!member) return jsonResponse({ error: "招待リンクが無効です。管理者に確認してください。" }, 400);
  if (member.registered_at) return jsonResponse({ error: "このリンクはすでに登録済みです。" }, 400);

  const name = String(payload?.name || member.name || "").trim();
  if (!name) return jsonResponse({ error: "氏名を入力してください。" }, 400);

  const contact = payload?.contact != null ? String(payload.contact).trim() : "";
  if (contact && !/^[0-9]{2,4}-[0-9]{2,4}-[0-9]{3,4}$/.test(contact)) {
    return jsonResponse({ error: "電話番号は「090-1234-5678」のようにハイフン区切りで入力してください。" }, 400);
  }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password: DEFAULT_PASSWORD,
    email_confirm: true,
  });

  if (createError || !created?.user) {
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
    .from("members")
    .update({
      name,
      short_name: payload?.shortName != null ? String(payload.shortName).trim() : member.short_name,
      contact,
      birth_date: payload?.birthDate || member.birth_date,
      costume_size: payload?.costumeSize != null ? String(payload.costumeSize).trim() : member.costume_size,
      tshirt_size: payload?.tshirtSize != null ? String(payload.tshirtSize).trim() : member.tshirt_size,
      registered_at: new Date().toISOString(),
    })
    .eq("id", member.id);

  await supabase.from("logs").insert({
    action: "メンバー本人登録",
    member_id: member.id,
    member_name: name,
    detail: `email: ${email}`,
  });

  return jsonResponse({ ok: true });
});
