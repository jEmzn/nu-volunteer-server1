-- NU Volunteer database (PostgreSQL 16+). Tables and indexes only: the rules that used to live in Postgres
-- functions now run in the API, and the database is never exposed, so there are no functions, RLS or publications.
-- Taken from the old site's supabase/schema.sql; the column list matches DATABASE.md.

create table students (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  reminders text[] not null default '{}',
  notify jsonb not null default '{}'
);

create table orgs (
  code text primary key,
  name text not null,
  admin boolean not null default false
);

create table activities (
  id text primary key,
  title text not null,
  category_key text not null,
  org text not null,
  org_code text not null,
  poster text not null default '',
  description text not null default '',
  place text not null default '',
  lat double precision,
  lng double precision,
  start_at timestamptz not null,
  end_at timestamptz not null,
  hours double precision not null,
  cap_limit boolean not null default false,
  capacity integer not null default 0,
  walk_in boolean not null default false,
  qr_mode text not null default 'dynamic' check (qr_mode in ('dynamic', 'static')),
  loc_mode text not null default 'on' check (loc_mode in ('on', 'off')),
  radius integer not null default 150,
  qr_interval integer not null default 10,
  supervisor_name text not null default '',
  supervisor_phone text not null default '',
  chat_enabled boolean not null default false,
  open_chat_url text,
  opens_at timestamptz,
  cancel_days integer,
  closed_at timestamptz,
  submitted_at timestamptz,
  recorded_at timestamptz,
  hidden boolean,
  hide_until_open boolean,
  created_at timestamptz not null default now(),
  reg_count integer not null default 0,
  credit_count integer not null default 0,
  items_per_hour integer,
  template_id text
);

create table templates (
  id text primary key,
  org_code text not null,
  title text not null,
  poster text not null default '',
  description text not null default '',
  hours double precision not null,
  settings jsonb not null default '{}',
  created_by text not null default '',
  created_at timestamptz not null default now()
);

create table registrations (
  activity_id text not null references activities (id) on delete cascade,
  student_id text not null,
  name text not null,
  at timestamptz not null default now(),
  walk_in boolean not null default false,
  cancelled_at timestamptz,
  late boolean not null default false,
  waived boolean not null default false,
  primary key (activity_id, student_id)
);

-- The primary key is what stops a second credit for the same person and activity.
create table credits (
  activity_id text not null references activities (id) on delete cascade,
  student_id text not null,
  name text not null,
  hours double precision not null,
  full_hours double precision not null,
  at timestamptz not null default clock_timestamp(),
  method text not null check (method in ('qr', 'manual')),
  distance double precision,
  accuracy double precision,
  flags text[] not null default '{}',
  device_id text,
  ref text,
  edited_by text,
  edited_at timestamptz,
  reason text,
  items integer,
  primary key (activity_id, student_id)
);

create table announcements (
  id uuid primary key default gen_random_uuid(),
  activity_id text not null references activities (id) on delete cascade,
  text text not null default '',
  images text[] not null default '{}',
  at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  activity_id text not null references activities (id) on delete cascade,
  author_id text not null,
  author_name text not null,
  text text not null,
  at timestamptz not null default now(),
  sup boolean not null default false
);

create table dms (
  id uuid primary key default gen_random_uuid(),
  activity_id text not null references activities (id) on delete cascade,
  student_id text not null,
  from_sup boolean not null default false,
  author_name text not null,
  text text not null,
  at timestamptz not null default now(),
  read boolean not null default false
);

create table notices (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  kind text not null,
  title text not null,
  body text not null default '',
  activity_id text,
  "to" text,
  at timestamptz not null default now(),
  read boolean not null default false
);

create index templates_org_idx on templates (org_code);
create index registrations_student_idx on registrations (student_id);
create index credits_student_idx on credits (student_id);
create index notices_student_idx on notices (student_id);
create index dms_activity_student_idx on dms (activity_id, student_id);
create index messages_activity_idx on messages (activity_id);
create index announcements_activity_idx on announcements (activity_id);
