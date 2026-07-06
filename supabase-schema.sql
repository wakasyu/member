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

alter table public.profiles enable row level security;
alter table public.members enable row level security;
alter table public.events enable row level security;
alter table public.answers enable row level security;
alter table public.logs enable row level security;

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

drop policy if exists "answers write authenticated" on public.answers;
create policy "answers write authenticated"
on public.answers for insert
to authenticated
with check (true);

drop policy if exists "answers update authenticated" on public.answers;
create policy "answers update authenticated"
on public.answers for update
to authenticated
using (true)
with check (true);

drop policy if exists "answers delete admin" on public.answers;
create policy "answers delete admin"
on public.answers for delete
to authenticated
using (public.is_admin());

drop policy if exists "logs read authenticated" on public.logs;
create policy "logs read authenticated"
on public.logs for select
to authenticated
using (true);

drop policy if exists "logs insert authenticated" on public.logs;
create policy "logs insert authenticated"
on public.logs for insert
to authenticated
with check (true);

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

-- 初回だけ実行：
-- 1. Supabaseの Authentication > Users で管理者ユーザーを作成する
-- 2. そのユーザーIDを下の 'ADMIN_USER_UUID' に入れてから実行する
--
-- insert into public.profiles (id, display_name, role)
-- values ('ADMIN_USER_UUID', '管理者', 'admin')
-- on conflict (id) do update set role = 'admin', display_name = excluded.display_name;
