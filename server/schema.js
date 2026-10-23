// Tables for the meeting polls. Every statement is idempotent so this can run
// on each cold start (see ensureSchema() in db.js). A change to an existing
// table needs an `alter table ... add column if not exists` here, not an edit
// of the `create table` — databases that already exist never re-run it.

module.exports = `
-- Two cold starts on an empty database would otherwise race to create the same
-- tables, and one of them would fail. The lock is held until this batch ends
-- (it runs as one implicit transaction) and is released automatically.
select pg_advisory_xact_lock(7262201);

create table if not exists polls (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  title text not null,
  description text not null default '',
  location text not null default '',
  duration_minutes integer not null check (duration_minutes between 5 and 1440),
  timezone text not null default 'Europe/Rome',
  deadline timestamptz,
  hide_responses boolean not null default false,
  status text not null default 'open' check (status in ('open', 'closed', 'scheduled')),
  final_slot_id uuid,
  calendar_event_id text,
  calendar_event_link text,
  meet_link text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists poll_slots (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  starts_at timestamptz not null,
  unique (poll_id, starts_at)
);

create table if not exists poll_responses (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  name text not null,
  email text not null,
  edit_token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists poll_responses_email
  on poll_responses (poll_id, lower(email));

-- Names too, so the answers table never shows two people under one name.
-- Names are stored with their whitespace collapsed (see cleanName in polls.js).
create unique index if not exists poll_responses_name
  on poll_responses (poll_id, lower(name));

-- value: 2 = yes, 1 = if needed, 0 = no
create table if not exists poll_votes (
  response_id uuid not null references poll_responses(id) on delete cascade,
  slot_id uuid not null references poll_slots(id) on delete cascade,
  value smallint not null check (value in (0, 1, 2)),
  primary key (response_id, slot_id)
);

-- Failed admin logins, for rate limiting. Old rows are pruned on each login.
create table if not exists login_attempts (
  ip text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists login_attempts_ip on login_attempts (ip, attempted_at);

-- People who can sign in to /app/. 'discord' users are created on their first
-- Discord login; the single 'admin' user is the shared-password login.
create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('admin', 'discord')),
  discord_id text unique,
  name text not null,
  avatar_url text,
  email text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create unique index if not exists app_users_one_admin on app_users (kind) where kind = 'admin';

insert into app_users (kind, name)
  select 'admin', 'Admin' where not exists (select 1 from app_users where kind = 'admin');

-- Every poll belongs to the user who created it. Polls from before accounts
-- existed go to the admin.
alter table polls add column if not exists owner_id uuid references app_users(id) on delete cascade;
create index if not exists polls_owner on polls (owner_id, created_at);
update polls set owner_id = (select id from app_users where kind = 'admin') where owner_id is null;

-- Site-wide settings edited from the admin's Settings page, e.g. 'smtp'.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- How each user wants to hear about their polls.
alter table app_users add column if not exists notify_channel text not null default 'email'
  check (notify_channel in ('email', 'discord', 'both', 'none'));
alter table app_users add column if not exists notify_email text;

-- Per poll: tell the owner about new answers (on by default), and whether
-- only invited people may answer.
alter table polls add column if not exists notify boolean not null default true;
alter table polls add column if not exists invite_only boolean not null default false;
alter table polls add column if not exists all_answered_at timestamptz;

-- Guests of an invite-only poll. Each gets a personal link carrying the token;
-- their answer is linked here once given.
create table if not exists poll_invites (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  email text not null,
  token text not null unique,
  response_id uuid references poll_responses(id) on delete set null,
  sent_at timestamptz,
  send_error text,
  created_at timestamptz not null default now()
);

create unique index if not exists poll_invites_email on poll_invites (poll_id, lower(email));

-- Who was emailed the calendar invite for the chosen time, so a change of
-- time can send them the cancellation; and the event's revision number.
alter table polls add column if not exists invited_to_meeting text[];
alter table polls add column if not exists meeting_sequence integer not null default 0;

-- A recurring meeting: { freq, interval, until, count } (see recurrence.js),
-- or null for a one-off.
alter table polls add column if not exists recurrence jsonb;

-- ── Content tool (/app/content/, server/content.js) ──────────────────────────

-- The Discord role ids a member held at their last sign-in (or last check
-- before publishing), which decide what they may publish.
alter table app_users add column if not exists roles text[] not null default '{}';

-- Which Discord role may do what with the site's content. permissions holds
-- keys from PERMISSIONS in server/permissions.js. Edited from the dashboard.
create table if not exists content_role_permissions (
  role_id text primary key,
  role_name text not null,
  permissions text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- Seminars and events published from the dashboard. entry is shaped like an
-- entry of data/events.yaml, so the site's templates read both the same way;
-- slug is its anchor on the page. Deleting only flags it, so it can be undone.
create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('seminar', 'event')),
  slug text not null unique,
  day date not null,
  entry jsonb not null,
  deleted boolean not null default false,
  created_by uuid references app_users(id) on delete set null,
  updated_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_items_day on content_items (day);

-- Every save, delete and restore, with the entry as it was after it: the
-- history shown in the dashboard, and what "restore this version" goes back to.
create table if not exists content_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references content_items(id) on delete cascade,
  action text not null check (action in ('create', 'update', 'delete', 'restore', 'import')),
  entry jsonb not null,
  user_id uuid references app_users(id) on delete set null,
  user_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists content_versions_item on content_versions (item_id, created_at);
`;
