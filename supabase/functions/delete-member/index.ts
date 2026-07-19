// Supabase Edge Function: delete-member
//
// 管理画面の「メンバー削除」でログインアカウント（Supabase Auth）も
// 一緒に削除するための管理者専用エンドポイント。
// auth.admin.deleteUser はservice_role権限が必要でクライアントから
// 直接呼べないため、ここに閉じ込める。
//
// register-memberと違い、こちらは誰でも叩けると困る（他人のアカウントを
// 消せてしまう）ため --no-verify-jwt にはしない。呼び出し元のJWTから
// 本人を特定し、profiles.role が admin であることをここでも確認してから
// 実行する。
//
// POST { userId }  … 指定したSupabase AuthユーザーIDを削除する
//                     （profiles行は auth.users への外部キーに
//                     on delete cascade が設定されているため自動的に消える）

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  if (req.method !== "POST") {
    return jsonResponse({ error: "unsupported method" }, 405);
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ error: "認証情報がありません。" }, 401);
  }

  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(token);
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "認証に失敗しました。" }, 401);
  }

  const { data: callerProfile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", callerData.user.id)
    .maybeSingle();

  if (profileError || !callerProfile || callerProfile.role !== "admin") {
    return jsonResponse({ error: "管理者のみ実行できます。" }, 403);
  }

  const payload = await req.json().catch(() => null);
  const userId = String(payload?.userId || "").trim();
  if (!userId) {
    return jsonResponse({ error: "userIdが指定されていません。" }, 400);
  }

  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteError && !/not.*found/i.test(deleteError.message || "")) {
    return jsonResponse({ error: `アカウント削除に失敗しました：${deleteError.message}` }, 400);
  }

  return jsonResponse({ ok: true });
});
