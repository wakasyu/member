create extension if not exists pgcrypto;

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
drop policy if exists "answers write authenticated" on public.answers;
drop policy if exists "answers insert self or admin" on public.answers;
create policy "answers insert self or admin"
on public.answers for insert
to authenticated
with check (
  public.is_admin()
  or member_id = (select member_id from public.profiles where id = auth.uid())
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
  or member_id = (select member_id from public.profiles where id = auth.uid())
);

drop policy if exists "answers delete admin" on public.answers;
drop policy if exists "answers delete self or admin" on public.answers;
create policy "answers delete self or admin"
on public.answers for delete
to authenticated
using (
  public.is_admin()
  or member_id = (select member_id from public.profiles where id = auth.uid())
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

insert into public.members (name, member_state, visible)
select seed.name, seed.member_state, seed.visible
from (
  values
    ('太郎', '在籍', true),
    ('宇野', '在籍', true),
    ('勝部', '在籍', true),
    ('土師', '在籍', true),
    ('時松', '在籍', true),
    ('繁森', '在籍', true)
) as seed(name, member_state, visible)
where not exists (
  select 1
  from public.members
  where public.members.name = seed.name
);

insert into public.list_options (option_type, label, sort_order)
select seed.option_type, seed.label, seed.sort_order
from (
  values
    ('event_category', '練習', 1),
    ('event_category', '演奏', 2),
    ('event_category', 'イベント', 3),
    ('event_category', 'ミーティング', 4),
    ('event_category', '準備', 5),
    ('event_category', '本番', 6),
    ('event_category', 'その他', 7),
    ('reason_category', '体調不良', 1),
    ('reason_category', '仕事', 2),
    ('reason_category', '学校', 3),
    ('reason_category', '私用', 4),
    ('reason_category', '時間変更', 5),
    ('reason_category', 'その他', 6)
) as seed(option_type, label, sort_order)
where not exists (
  select 1
  from public.list_options
  where public.list_options.option_type = seed.option_type
    and public.list_options.label = seed.label
);

-- 初回だけ実行：
-- 1. Supabaseの Authentication > Users で管理者ユーザーを作成する
-- 2. そのユーザーIDを下の 'ADMIN_USER_UUID' に入れてから実行する
--
-- insert into public.profiles (id, display_name, role)
-- values ('ADMIN_USER_UUID', '管理者', 'admin')
-- on conflict (id) do update set role = 'admin', display_name = excluded.display_name;
