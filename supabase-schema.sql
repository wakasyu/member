create extension if not exists pgcrypto;

-- 一部のプロジェクトではservice_role（Edge Functionなどサーバー側からの操作）に
-- テーブルへのGRANTが不足していることがあるため明示しておく。
-- (RLSはbypassされてもテーブル自体へのGRANTが無いとpermission deniedになる)
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;

-- 同様に、SQL Editorから直接作成したテーブル（list_optionsなど）は
-- anon/authenticatedへのGRANTが自動で付かないことがある。
-- RLSポリシーが実際のアクセス制御を行うので、ここでのGRANTは
-- 「操作を試みる権限」を開放するだけで安全。
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant usage, select on all sequences in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on tables to anon;

-- Database Webhook（メール通知など）で使う。Supabaseダッシュボードの
-- Database > Webhooks からWebhookを1つ以上作ると自動で有効化されるインフラだが、
-- SQLからも明示的にセットアップしておく。
create extension if not exists pg_net;

create schema if not exists supabase_functions;

create table if not exists supabase_functions.hooks (
  id bigserial primary key,
  hook_table_id integer not null,
  hook_name text not null,
  created_at timestamptz default now(),
  request_id bigint
);

create index if not exists supabase_functions_hooks_request_id_idx on supabase_functions.hooks using btree (request_id);
create index if not exists supabase_functions_hooks_h_table_id_h_name_idx on supabase_functions.hooks using btree (hook_table_id, hook_name);

-- security definerが無いと、一般メンバーがanswersに書き込んだ際にこのトリガーが
-- 「呼び出したメンバー自身の権限」で実行されてしまい、supabase_functionsスキーマに
-- アクセスできず "permission denied for schema supabase_functions" になる。
-- 関数の所有者（管理者権限）で実行されるようにする。
create or replace function supabase_functions.http_request()
returns trigger
language plpgsql
security definer
set search_path = supabase_functions, net, public
as $$
declare
  request_id bigint;
  payload jsonb;
  url text := TG_ARGV[0]::text;
  method text := TG_ARGV[1]::text;
  headers jsonb default '{}'::jsonb;
  params jsonb default '{}'::jsonb;
  timeout_ms integer default 1000;
begin
  if url is null or method is null then
    raise exception 'url and method are required';
  end if;

  if TG_ARGV[2] is null then
    headers = '{"Content-Type":"application/json"}'::jsonb;
  else
    headers = TG_ARGV[2]::jsonb;
  end if;

  if TG_ARGV[3] is null then
    params = '{}'::jsonb;
  else
    params = TG_ARGV[3]::jsonb;
  end if;

  if TG_ARGV[4] is null then
    timeout_ms = 1000;
  else
    timeout_ms = TG_ARGV[4]::integer;
  end if;

  case
    when method = 'GET' then
      select net.http_get(url, params, headers, timeout_ms) into request_id;
    when method = 'POST' then
      payload = jsonb_build_object('old_record', OLD, 'record', NEW, 'type', TG_OP, 'table', TG_TABLE_NAME, 'schema', TG_TABLE_SCHEMA);
      select net.http_post(url, payload, params, headers, timeout_ms) into request_id;
    else
      raise exception 'method argument % is invalid', method;
  end case;

  insert into supabase_functions.hooks(hook_table_id, hook_name, request_id) values (TG_RELID, TG_NAME, request_id);

  return NEW;
end
$$;

grant usage on schema supabase_functions to postgres, anon, authenticated, service_role;
grant all on supabase_functions.hooks to postgres, anon, authenticated, service_role;
grant usage on schema net to postgres, anon, authenticated, service_role;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'member' check (role in ('admin', 'member')),
  member_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  grade text not null default '',
  age integer null,
  contact text not null default '',
  join_date date null,
  leave_date date null,
  member_state text not null default '在籍' check (member_state in ('在籍', '休会', '退会')),
  note text not null default '',
  costume_size text not null default '',
  bag_size text not null default '',
  visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 同姓同名の登録を防ぐ（人主体表示は名前ではなくIDで名寄せするが、念のためDBでも重複を防止する）
create unique index if not exists members_name_unique_idx on public.members (lower(name));

-- 予定一覧などフルネームを出したくない場面用の表示名（空なら氏名をそのまま使う）
alter table public.members add column if not exists short_name text not null default '';
-- 年齢は日々古くなるため、生年月日を保持して画面側で年齢を計算する（age列は使わなくなるが残す）
alter table public.members add column if not exists birth_date date null;
-- Tシャツサイズを追加。袋サイズ(bag_size)は運用上不要になったためアプリの画面からは外すが、
-- 既存データを消さないよう列自体は残す。
alter table public.members add column if not exists tshirt_size text not null default '';
-- 担当（役割）を管理できるようにする
alter table public.members add column if not exists duty text not null default '';
-- 予定一覧などでの表示順。管理画面のメンバー一覧から並び替えられるようにする
alter table public.members add column if not exists sort_order integer not null default 0;

-- メンバー自己登録は「既存メンバー行に招待トークンを付与する」方式ではなく、
-- 招待トークン自体を管理する専用テーブル（member_invites）に置き換えたため、
-- この方式で使っていた列は使用しない。
drop index if exists members_registration_token_unique_idx;
alter table public.members drop column if exists registration_token;
alter table public.members drop column if exists registered_at;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'その他',
  date date not null,
  start_time time null,
  end_time time null,
  place text not null default '',
  place_url text null,
  creator text not null default '',
  answer_deadline date null,
  note text not null default '',
  -- 予定ごとの日程調整リンクに使うトークンです。
  -- URLでは ?schedule=... として使います。
  answer_token text not null unique default encode(gen_random_bytes(18), 'hex'),
  public_state text not null default '公開' check (public_state in ('公開', '削除')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 対象メンバー全員が回答し終わった時の「完了メール」を二重送信しないための記録用
alter table public.events add column if not exists completion_notified_at timestamptz null;

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  status text not null check (status in ('参加', '不参加', '未定', '未回答')),
  pending_until date null,
  comment text not null default '',
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, member_id)
);

-- 理由を「カテゴリ：詳細」の1文字列に押し込めると、自由入力欄にたまたま
-- カテゴリ名を書かれた場合に再表示時の解析を誤るため、カラムを分ける。
-- 旧`reason`列は過去データ保持のため残すが、アプリからは読み書きしない。
alter table public.answers add column if not exists reason_category text not null default '';
alter table public.answers add column if not exists reason_detail text not null default '';

update public.answers
set
  reason_category = case
    when reason = '体調不良' or reason like '体調不良：%' then '体調不良'
    when reason = '仕事' or reason like '仕事：%' then '仕事'
    when reason = '学校' or reason like '学校：%' then '学校'
    when reason = '私用' or reason like '私用：%' then '私用'
    when reason = '時間変更' or reason like '時間変更：%' then '時間変更'
    when reason = 'その他' or reason like 'その他：%' then 'その他'
    else ''
  end,
  reason_detail = case
    when reason like '体調不良：%' then substring(reason from length('体調不良：') + 1)
    when reason like '仕事：%' then substring(reason from length('仕事：') + 1)
    when reason like '学校：%' then substring(reason from length('学校：') + 1)
    when reason like '私用：%' then substring(reason from length('私用：') + 1)
    when reason like '時間変更：%' then substring(reason from length('時間変更：') + 1)
    when reason like 'その他：%' then substring(reason from length('その他：') + 1)
    when reason in ('体調不良', '仕事', '学校', '私用', '時間変更', 'その他') then ''
    else reason
  end
where reason_category = '' and reason_detail = '' and coalesce(reason, '') <> '';

create table if not exists public.logs (
  id bigint generated always as identity primary key,
  action text not null,
  event_id uuid null,
  event_name text not null default '',
  member_id uuid null,
  member_name text not null default '',
  old_status text not null default '',
  new_status text not null default '',
  detail text not null default '',
  created_at timestamptz not null default now()
);

-- 「誰が」操作したかを残す（対象者だけでなく実行者も記録する）
alter table public.logs add column if not exists actor_id uuid references auth.users(id) on delete set null;
alter table public.logs add column if not exists actor_name text not null default '';

-- 予定の分類・回答理由の選択肢を管理者がアプリから追加/削除できるようにする
create table if not exists public.list_options (
  id uuid primary key default gen_random_uuid(),
  option_type text not null check (option_type in ('event_category', 'reason_category')),
  label text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (option_type, label)
);

-- 新しい予定を立てる前段階の「期間指定の日程調整」。
-- 特定の1予定に紐づく出欠（answers）とは別物で、期間内の日付×時間帯ごとに
-- 各メンバーが空いている時間をドラッグ選択して申告する。
create table if not exists public.availability_polls (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  note text not null default '',
  period_start date not null,
  period_end date not null,
  day_start_minutes integer not null default 540,
  day_end_minutes integer not null default 1320,
  slot_minutes integer not null default 30,
  public_state text not null default '公開' check (public_state in ('公開', '削除')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1メンバー・1日・1時間帯（slot_start_minutesはその日の0:00からの分）ごとに
-- 「空いている」という申告を1行で表す。ドラッグ選択の追加/解除はinsert/deleteで行う。
create table if not exists public.availability_slots (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.availability_polls(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  slot_date date not null,
  slot_start_minutes integer not null,
  created_at timestamptz not null default now(),
  unique (poll_id, member_id, slot_date, slot_start_minutes)
);

-- 候補日程調整に対する、メンバー1人につき1件の自由記述の備考
-- （「後半は難しいかも」等、時間帯の申告だけでは伝えづらい補足用）
create table if not exists public.availability_notes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.availability_polls(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  note text not null default '',
  updated_at timestamptz not null default now(),
  unique (poll_id, member_id)
);

-- 新規メンバー登録リンク用のトークン。既存メンバー行とは紐づかない
-- （事前に名前などを入力しておく必要はなく、登録フォーム側の入力内容から
-- membersテーブルの行そのものをEdge Function（service_role）が新規作成する）。
create table if not exists public.member_invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz null,
  created_member_id uuid references public.members(id) on delete set null
);

grant select, insert, update, delete on public.member_invites to authenticated;

alter table public.profiles enable row level security;
alter table public.members enable row level security;
alter table public.events enable row level security;
alter table public.answers enable row level security;
alter table public.logs enable row level security;
alter table public.list_options enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

-- roleとmember_idは権限に直結するため、アプリ経由（PostgREST + 一般ユーザーのJWT）で
-- 管理者以外が書き換えられないようDBレベルで防ぐ。
-- (RLSのwith checkだけだと「自分の行を更新できる」ことしか保証できず、
--  一般メンバーが自分自身のroleをadminに書き換えられてしまう抜け穴があった)
-- auth.uid()がnullになるSQL Editor / service_role経由の操作（管理者がSupabase側で
-- 直接実行する場合）はチェック対象外にする。そこは元々DBに直接触れる権限を持つ人しか
-- 実行できないため、アプリ側のなりすまし対策としては意味がなく、逆に管理作業を
-- ブロックしてしまうだけになるため。
create or replace function public.profiles_guard_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'role の変更は管理者のみ行えます。';
    end if;
    if new.member_id is distinct from old.member_id then
      raise exception 'member_id の変更は管理者のみ行えます。';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_privileged_fields on public.profiles;
create trigger profiles_guard_privileged_fields
before update on public.profiles
for each row execute function public.profiles_guard_privileged_fields();

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'profiles_member_id_fkey'
      and table_name = 'profiles'
  ) then
    alter table public.profiles
      add constraint profiles_member_id_fkey
      foreign key (member_id) references public.members(id) on delete set null;
  end if;
end;
$$;

drop policy if exists "profiles read own or admin" on public.profiles;
create policy "profiles read own or admin"
on public.profiles for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles update own name or admin" on public.profiles;
create policy "profiles update own name or admin"
on public.profiles for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

drop policy if exists "profiles insert by admin" on public.profiles;
create policy "profiles insert by admin"
on public.profiles for insert
to authenticated
with check (public.is_admin());

drop policy if exists "members read authenticated" on public.members;
create policy "members read authenticated"
on public.members for select
to authenticated
using (true);

drop policy if exists "members write admin" on public.members;
create policy "members write admin"
on public.members for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "events read authenticated" on public.events;
create policy "events read authenticated"
on public.events for select
to authenticated
using (true);

drop policy if exists "events write admin" on public.events;
create policy "events write admin"
on public.events for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "answers read authenticated" on public.answers;
create policy "answers read authenticated"
on public.answers for select
to authenticated
using (true);

-- 出欠回答は「本人の分」か管理者だけが書き込み/削除できるようにする
-- (以前は認証済みなら誰でも他人の回答を書き換えられた)
-- さらに回答期限を過ぎた予定は、管理者以外は書き込み/削除できないようにする
-- (画面側の入力欄無効化だけだとAPIを直接叩けば回避できてしまうため)
create or replace function public.answer_deadline_ok(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.events e
    where e.id = target_event_id
      and e.answer_deadline is not null
      and e.answer_deadline < current_date
  );
$$;

drop policy if exists "answers write authenticated" on public.answers;
drop policy if exists "answers insert self or admin" on public.answers;
create policy "answers insert self or admin"
on public.answers for insert
to authenticated
with check (
  public.is_admin()
  or (
    member_id = (select member_id from public.profiles where id = auth.uid())
    and public.answer_deadline_ok(event_id)
  )
);

drop policy if exists "answers update authenticated" on public.answers;
drop policy if exists "answers update self or admin" on public.answers;
create policy "answers update self or admin"
on public.answers for update
to authenticated
using (
  public.is_admin()
  or member_id = (select member_id from public.profiles where id = auth.uid())
)
with check (
  public.is_admin()
  or (
    member_id = (select member_id from public.profiles where id = auth.uid())
    and public.answer_deadline_ok(event_id)
  )
);

drop policy if exists "answers delete admin" on public.answers;
drop policy if exists "answers delete self or admin" on public.answers;
create policy "answers delete self or admin"
on public.answers for delete
to authenticated
using (
  public.is_admin()
  or (
    member_id = (select member_id from public.profiles where id = auth.uid())
    and public.answer_deadline_ok(event_id)
  )
);

drop policy if exists "logs read authenticated" on public.logs;
create policy "logs read authenticated"
on public.logs for select
to authenticated
using (true);

-- ログの記録者(actor_id)を偽装できないようにする
drop policy if exists "logs insert authenticated" on public.logs;
drop policy if exists "logs insert self" on public.logs;
create policy "logs insert self"
on public.logs for insert
to authenticated
with check (actor_id = auth.uid());

drop policy if exists "list_options read authenticated" on public.list_options;
create policy "list_options read authenticated"
on public.list_options for select
to authenticated
using (true);

drop policy if exists "list_options write admin" on public.list_options;
create policy "list_options write admin"
on public.list_options for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

alter table public.availability_polls enable row level security;
alter table public.availability_slots enable row level security;

drop policy if exists "availability_polls read authenticated" on public.availability_polls;
create policy "availability_polls read authenticated"
on public.availability_polls for select
to authenticated
using (true);

drop policy if exists "availability_polls write admin" on public.availability_polls;
create policy "availability_polls write admin"
on public.availability_polls for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- 全員分の入力が見えないと「重なっている時間帯」を計算できないため、
-- 出欠回答(answers)と同様に閲覧は全員に開放し、書き込みは本人か管理者のみに絞る。
drop policy if exists "availability_slots read authenticated" on public.availability_slots;
create policy "availability_slots read authenticated"
on public.availability_slots for select
to authenticated
using (true);

drop policy if exists "availability_slots write self or admin" on public.availability_slots;
create policy "availability_slots write self or admin"
on public.availability_slots for all
to authenticated
using (
  public.is_admin()
  or member_id = (select member_id from public.profiles where id = auth.uid())
)
with check (
  public.is_admin()
  or member_id = (select member_id from public.profiles where id = auth.uid())
);

alter table public.availability_notes enable row level security;

drop policy if exists "availability_notes read authenticated" on public.availability_notes;
create policy "availability_notes read authenticated"
on public.availability_notes for select
to authenticated
using (true);

drop policy if exists "availability_notes write self or admin" on public.availability_notes;
create policy "availability_notes write self or admin"
on public.availability_notes for all
to authenticated
using (
  public.is_admin()
  or member_id = (select member_id from public.profiles where id = auth.uid())
)
with check (
  public.is_admin()
  or member_id = (select member_id from public.profiles where id = auth.uid())
);

-- 招待トークンの発行・一覧確認は管理者のみ。実際にトークンを検証して
-- メンバー行を作るのはEdge Function（service_role、RLSをbypass）なので
-- ここに一般メンバー・匿名向けのポリシーは不要。
alter table public.member_invites enable row level security;

drop policy if exists "member_invites admin only" on public.member_invites;
create policy "member_invites admin only"
on public.member_invites for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'availability_polls'
  ) then
    alter publication supabase_realtime add table public.availability_polls;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'availability_slots'
  ) then
    alter publication supabase_realtime add table public.availability_slots;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'availability_notes'
  ) then
    alter publication supabase_realtime add table public.availability_notes;
  end if;
end;
$$;

-- トップページのスライドショー写真置き場。ログインしていない人には一切見せない
-- （publicなbucketにしない = 直リンクでも見えないようにする）。
insert into storage.buckets (id, name, public)
values ('top-photos', 'top-photos', false)
on conflict (id) do nothing;

drop policy if exists "top-photos read authenticated" on storage.objects;
create policy "top-photos read authenticated"
on storage.objects for select
to authenticated
using (bucket_id = 'top-photos');

drop policy if exists "top-photos insert admin" on storage.objects;
create policy "top-photos insert admin"
on storage.objects for insert
to authenticated
with check (bucket_id = 'top-photos' and public.is_admin());

drop policy if exists "top-photos update admin" on storage.objects;
create policy "top-photos update admin"
on storage.objects for update
to authenticated
using (bucket_id = 'top-photos' and public.is_admin())
with check (bucket_id = 'top-photos' and public.is_admin());

drop policy if exists "top-photos delete admin" on storage.objects;
create policy "top-photos delete admin"
on storage.objects for delete
to authenticated
using (bucket_id = 'top-photos' and public.is_admin());

-- リアルタイム反映（他の人の操作を自動的に画面へ反映する）のためのpublication登録
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'members'
  ) then
    alter publication supabase_realtime add table public.members;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'answers'
  ) then
    alter publication supabase_realtime add table public.answers;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'list_options'
  ) then
    alter publication supabase_realtime add table public.list_options;
  end if;
end;
$$;

-- 初期セットアップ用のサンプルメンバー・サンプル分類の自動投入は廃止した。
-- （本番データが入った後も、削除したはずのサンプルがこのSQLを再実行する
-- たびに復活してしまい、都度消す手間が発生していたため）
-- 初回セットアップ時にメンバーや分類が必要な場合は、アプリの管理画面
-- （メンバー追加／分類管理）から手動で追加してください。

-- 初回だけ実行：
-- 1. Supabaseの Authentication > Users で管理者ユーザーを作成する
-- 2. そのユーザーIDを下の 'ADMIN_USER_UUID' に入れてから実行する
--
-- insert into public.profiles (id, display_name, role)
-- values ('ADMIN_USER_UUID', '管理者', 'admin')
-- on conflict (id) do update set role = 'admin', display_name = excluded.display_name;

-- メール通知（回答時・全員回答完了時）を有効にする場合だけ実行：
-- 1. supabase/functions/notify-answer を `supabase functions deploy notify-answer --no-verify-jwt` でデプロイする
-- 2. `supabase secrets set RESEND_API_KEY=... ADMIN_NOTIFY_EMAIL=... NOTIFY_FROM_EMAIL=... WEBHOOK_SECRET=...` を設定する
-- 3. 下のSQLの YOUR_PROJECT_REF と YOUR_WEBHOOK_SECRET を実際の値に置き換えて実行する
--    （WEBHOOK_SECRETは他人にこの関数を叩かれないための合言葉。secretsに設定したものと同じ値にする）
--
-- drop trigger if exists notify_answer_change on public.answers;
-- create trigger notify_answer_change
-- after insert or update on public.answers
-- for each row execute function supabase_functions.http_request(
--   'https://YOUR_PROJECT_REF.supabase.co/functions/v1/notify-answer',
--   'POST',
--   '{"Content-type":"application/json","x-webhook-secret":"YOUR_WEBHOOK_SECRET"}',
--   '{}',
--   '5000'
-- );
