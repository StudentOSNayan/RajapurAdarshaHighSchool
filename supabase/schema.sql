-- =============================================================================
--  রাজাপুর আদর্শ উচ্চ বিদ্যালয় — CMS database schema (Supabase / PostgreSQL)
--  Run this once in the Supabase SQL editor of the project you create.
--  It is idempotent: safe to re-run.
--
--  Nothing here contains school facts. The tables start empty; the Computer
--  Teacher fills them with real content. The public site keeps showing its
--  current, approved static content until rows are actually published.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Accounts
--    `cms_users` holds the admin login(s). Passwords are stored ONLY as a
--    scrypt hash (never plaintext, never a reversible form).
--    role: 'admin' can manage accounts; 'staff' can manage content only.
-- -----------------------------------------------------------------------------
create table if not exists cms_users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique,
  full_name       text not null,
  role            text not null default 'staff' check (role in ('admin', 'staff')),
  password_hash   text not null,
  is_active       boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint cms_users_email_shape check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint cms_users_name_shape  check (char_length(trim(full_name)) between 2 and 80),
  constraint cms_users_email_lower check (email = lower(email))
);

-- -----------------------------------------------------------------------------
-- 2. Sessions
--    A login creates a random 256-bit token. The browser only ever receives
--    that token (in an HttpOnly cookie). The database stores its SHA-256 hash,
--    so a leaked table dump cannot be replayed as a cookie.
-- -----------------------------------------------------------------------------
create table if not exists cms_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references cms_users (id) on delete cascade,
  token_hash text not null unique,
  ip         text,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists cms_sessions_user_idx on cms_sessions (user_id);
create index if not exists cms_sessions_expiry_idx on cms_sessions (expires_at);

-- -----------------------------------------------------------------------------
-- 3. Audit trail
--    Every write is recorded with actor + timestamp, so nothing (especially a
--    deletion) can happen silently.
-- -----------------------------------------------------------------------------
create table if not exists cms_audit (
  id         bigint generated always as identity primary key,
  user_id    uuid references cms_users (id) on delete set null,
  user_email text,
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists cms_audit_created_idx on cms_audit (created_at desc);

-- -----------------------------------------------------------------------------
-- 4. Shared content columns
--    status drives public visibility: only 'published' is ever exposed.
-- -----------------------------------------------------------------------------
--  notices ---------------------------------------------------------------
create table if not exists notices (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null,
  audience      text,                                  -- e.g. "সকল শ্রেণি" (entered by the school)
  notice_type   text not null default 'general'
                check (notice_type in ('general', 'exam', 'result', 'admission', 'event', 'emergency')),
  importance    text not null default 'normal' check (importance in ('normal', 'urgent')),
  published_at  date not null default (current_date),
  status        text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  file_path     text,                                  -- optional PDF, media bucket key
  file_name     text,
  file_mime     text,
  file_bytes    integer,
  created_by    uuid references cms_users (id) on delete set null,
  updated_by    uuid references cms_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint notices_title_shape check (char_length(btrim(title)) between 4 and 220),
  constraint notices_body_shape  check (char_length(btrim(body)) between 2 and 8000),
  constraint notices_pub_date_required
    check (status <> 'published' or published_at is not null)
);
create index if not exists notices_public_idx on notices (published_at desc, created_at desc)
  where deleted_at is null and status = 'published';
create index if not exists notices_admin_idx on notices (updated_at desc) where deleted_at is null;

--  exam routines ---------------------------------------------------------
create table if not exists exam_routines (
  id           uuid primary key default gen_random_uuid(),
  exam_name    text not null,                           -- e.g. " bardic / model test name given by school"
  class_name   text not null,
  subject      text not null,
  exam_date    date not null,
  start_time   time,
  room         text,
  notes        text,
  file_path    text,
  file_name    text,
  file_mime    text,
  file_bytes   integer,
  sort_order   integer not null default 0,
  status       text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  published_at date not null default (current_date),
  created_by   uuid references cms_users (id) on delete set null,
  updated_by   uuid references cms_users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint exam_routines_name_shape check (char_length(btrim(exam_name)) between 2 and 160),
  constraint exam_routines_class_shape check (char_length(btrim(class_name)) between 1 and 40),
  constraint exam_routines_subject_shape check (char_length(btrim(subject)) between 1 and 120),
  constraint exam_routines_notes_shape check (notes is null or char_length(notes) <= 1000),
  constraint exam_routines_pub_date_required
    check (status <> 'published' or published_at is not null)
);
create index if not exists exam_routines_public_idx on exam_routines (exam_date, sort_order)
  where deleted_at is null and status = 'published';
create index if not exists exam_routines_admin_idx on exam_routines (updated_at desc) where deleted_at is null;

--  other routines (class routine, activity, events, holidays…) ----------
--  Intentionally generic: a free-text `routine_type` so new kinds of routine
--  never need a code change or a migration.
create table if not exists routines (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  routine_type text not null default 'general',         -- class routine / activity / holiday / …
  class_name   text,
  event_date   date,
  start_time   time,
  end_time     time,
  description  text,
  file_path    text,
  file_name    text,
  file_mime    text,
  file_bytes   integer,
  status       text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  published_at date not null default (current_date),
  created_by   uuid references cms_users (id) on delete set null,
  updated_by   uuid references cms_users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint routines_title_shape check (char_length(btrim(title)) between 3 and 200),
  constraint routines_type_shape  check (char_length(btrim(routine_type)) between 2 and 60),
  constraint routines_desc_shape  check (description is null or char_length(description) <= 4000),
  constraint routines_pub_date_required
    check (status <> 'published' or published_at is not null)
);
create index if not exists routines_public_idx on routines (event_date desc, created_at desc)
  where deleted_at is null and status = 'published';
create index if not exists routines_admin_idx on routines (updated_at desc) where deleted_at is null;

--  gallery: albums + photos ----------------------------------------------
create table if not exists albums (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  category     text,                                    -- optional label shown as a .tag
  album_date   date,
  cover_photo_id uuid,
  status       text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  published_at date not null default (current_date),
  created_by   uuid references cms_users (id) on delete set null,
  updated_by   uuid references cms_users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint albums_title_shape check (char_length(btrim(title)) between 2 and 160),
  constraint albums_desc_shape  check (description is null or char_length(description) <= 1000),
  constraint albums_pub_date_required
    check (status <> 'published' or published_at is not null)
);
create index if not exists albums_public_idx on albums (album_date desc, created_at desc)
  where deleted_at is null and status = 'published';

create table if not exists photos (
  id          uuid primary key default gen_random_uuid(),
  album_id    uuid not null references albums (id) on delete cascade,
  file_path   text not null unique,
  alt_text    text,                                     -- accessibility: meaningful description
  caption     text,
  bytes       integer,
  mime        text,
  pixel_width integer,
  pixel_height integer,
  sort_order  integer not null default 0,
  created_by  uuid references cms_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint photos_alt_shape check (alt_text is null or char_length(alt_text) <= 300),
  constraint photos_caption_shape check (caption is null or char_length(caption) <= 300)
);
create index if not exists photos_album_idx on photos (album_id, sort_order) where deleted_at is null;

-- Publishing rules that need to look at another table (an album must have at
-- least one photo before it can go public, a published photo must belong to a
-- published album) cannot be CHECK constraints in Postgres — they are enforced
-- in api/_lib/publish.mjs, which is the only code path that writes these rows.


-- -----------------------------------------------------------------------------
-- 5. Row Level Security
--    Every table is locked down for the anon / authenticated roles: nothing on
--    the public site can read these tables directly. The server-side API is the
--    only reader (it uses the service-role key, which bypasses RLS) and it
--    filters to status = 'published' before anything reaches a browser.
--    Triggers emulate Supabase's updated_at maintenance without extra setup.
-- -----------------------------------------------------------------------------
alter table cms_users      enable row level security;
alter table cms_sessions   enable row level security;
alter table cms_audit      enable row level security;
alter table notices        enable row level security;
alter table exam_routines  enable row level security;
alter table routines       enable row level security;
alter table albums         enable row level security;
alter table photos         enable row level security;

-- Explicitly deny anon/authenticated (no policy = deny by default; these make the intent
-- readable and survive a future "create policy for public" mistake being reviewed).
revoke all on all tables in schema public from anon, authenticated;
grant  usage on schema public to service_role;
grant  all on all tables in schema public to service_role;
grant  all on all sequences in schema public to service_role;

create or replace function cms_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

do $$
declare t text;
begin
  foreach t in array array['cms_users','notices','exam_routines','routines','albums','photos']
  loop
    execute format('drop trigger if exists %I on %I', 'cms_set_updated_at', t);
    execute format('create trigger %I before update on %I for each row execute function cms_touch_updated_at()',
                   'cms_set_updated_at', t);
  end loop;
end$$;

-- -----------------------------------------------------------------------------
-- 6. Storage bucket for uploads (photos + PDFs)
--    Private bucket: objects are only reachable through the API's signed URLs,
--    so unpublished photos can never be fetched by guessing a link.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- No storage policies for anon/authenticated => only the service role can touch objects.
-- (The admin API signs short-lived URLs for the browser when a preview is needed.)

-- -----------------------------------------------------------------------------
-- Done. The next step is not SQL: with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
-- set on Vercel, open  /admin/  with CMS_ALLOW_SETUP=1 for one deploy, fill in the
-- first account (email, name, password) and remove that variable again.
-- The password is never stored here — the API keeps only an scrypt hash in
-- cms_users.password_hash, and every later account is added from the
-- "অ্যাকাউন্ট" screen by that first admin.
-- =============================================================================
