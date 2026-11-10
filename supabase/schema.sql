-- Flipbook photobooth prototype — run once in Supabase → SQL Editor.

create extension if not exists pgcrypto;

-- ── Sessions ──────────────────────────────────────────────────────────────
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,               -- public link: /s/<slug>
  name        text not null default '',           -- label, e.g. customer name / booking no.
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 days',
  purged_at   timestamptz                         -- set by the cleanup cron when files are deleted
);
create index if not exists sessions_expires_idx on public.sessions (expires_at) where purged_at is null;

-- ── Frame templates ───────────────────────────────────────────────────────
-- overlay = PNG with transparent holes; slots = [{x,y,w,h}] in overlay pixels
create table if not exists public.templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  width       int  not null,
  height      int  not null,
  overlay_key text not null,
  slots       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

-- ── Photos ────────────────────────────────────────────────────────────────
create table if not exists public.photos (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  kind        text not null check (kind in ('raw', 'framed')),
  storage_key text not null,                      -- path in the "photos" storage bucket
  thumb_key   text not null,
  width       int  not null,
  height      int  not null,
  template_id uuid references public.templates(id) on delete set null,
  created_at  timestamptz not null default now()
);
-- (renames the column if an older version of this file was already run)
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'photos' and column_name = 'r2_key') then
    alter table public.photos rename column r2_key to storage_key;
  end if;
end $$;

create index if not exists photos_session_idx on public.photos (session_id, kind, created_at);

-- ── Video takes (flipbook) ──────────────────────────────────────────────
-- A take = frames sampled from one video in the browser (the video itself is never uploaded).
-- Its frames are photos with kind = 'frame', ordered by frame_index = flipbook page order.
create table if not exists public.takes (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  fps         numeric not null,                   -- sampling rate used (frames per second of video)
  source_name text not null default '',           -- original video file name, for staff
  created_at  timestamptz not null default now()
);
create index if not exists takes_session_idx on public.takes (session_id, created_at);

alter table public.photos add column if not exists take_id uuid references public.takes(id) on delete cascade;
alter table public.photos add column if not exists frame_index int;
alter table public.photos drop constraint if exists photos_kind_check;
alter table public.photos add constraint photos_kind_check check (kind in ('raw', 'framed', 'frame'));
create index if not exists photos_take_idx on public.photos (take_id, frame_index) where take_id is not null;

-- ── Flipbook design + video (2026-11-10) ───────────────────────────────────
-- templates.kind: 'photo' = frame for the photo composer, 'flipbook' = page design (one photo hole,
-- incl. the binding margin) applied on top of flipbook pages. Pages are never modified; the design,
-- cover and rendered MP4 live on the take.
alter table public.templates add column if not exists kind text not null default 'photo';
alter table public.templates drop constraint if exists templates_kind_check;
alter table public.templates add constraint templates_kind_check check (kind in ('photo', 'flipbook'));

alter table public.takes add column if not exists design_template_id uuid references public.templates(id) on delete set null;
alter table public.takes add column if not exists cover jsonb;        -- {enabled, title, subtitle}
alter table public.takes add column if not exists video_key text;     -- rendered MP4 in storage, null = not rendered

-- ── Row Level Security ────────────────────────────────────────────────────
-- Admin UI (logged-in user) reads/writes directly. The public gallery never
-- touches these tables; it goes through the API, which checks expiry.
-- IMPORTANT: disable public sign-ups (Authentication → Sign In / Providers)
-- and create the admin user by hand, so "authenticated" == staff.
alter table public.sessions  enable row level security;
alter table public.templates enable row level security;
alter table public.photos    enable row level security;
alter table public.takes     enable row level security;

drop policy if exists "staff all sessions"  on public.sessions;
drop policy if exists "staff all templates" on public.templates;
drop policy if exists "staff read photos"   on public.photos;
drop policy if exists "staff read takes"    on public.takes;

create policy "staff all sessions"  on public.sessions  for all    to authenticated using (true) with check (true);
create policy "staff all templates" on public.templates for all    to authenticated using (true) with check (true);
-- photo rows are written by the API (service role) together with the file upload
create policy "staff read photos"   on public.photos    for select to authenticated using (true);
-- takes are created/deleted by the API together with their frames
create policy "staff read takes"    on public.takes     for select to authenticated using (true);

-- ── Storage bucket ────────────────────────────────────────────────────────
-- Private bucket for photos + frame overlays. No storage policies on purpose:
-- only the API (service role) reads/writes it, so expiry is always enforced.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 26214400, array['image/jpeg', 'image/png', 'video/mp4'])
on conflict (id) do nothing;
-- (existing installs: allow the rendered flipbook videos)
update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'video/mp4'] where id = 'photos';
