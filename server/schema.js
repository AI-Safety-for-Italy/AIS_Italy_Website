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

-- ── CRM board (/app/crm/, server/crm/) ───────────────────────────────────────

-- When the Discord roles above were last read from Discord: at sign-in, and
-- again before writes and, if older than a few minutes, before reads.
alter table app_users add column if not exists roles_checked_at timestamptz;

-- Who looked at or changed which CRM record. Append-only on purpose: the
-- triggers refuse any update, delete or truncate, so no bug or stray query
-- can rewrite the history. No foreign key to app_users for the same reason (a
-- cascade would be an update); user_name keeps the name as it was.
-- subject_key is the opaque person key (see server/crm/crypto.js), never an
-- email.
create table if not exists crm_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  user_name text not null,
  action text not null,
  subject_key text,
  detail jsonb
);

create index if not exists crm_audit_subject on crm_audit (subject_key, at);
create index if not exists crm_audit_user on crm_audit (user_id, at);

create or replace function crm_audit_append_only() returns trigger as $$
begin
  raise exception 'crm_audit is append-only';
end;
$$ language plpgsql;

drop trigger if exists crm_audit_no_change on crm_audit;
create trigger crm_audit_no_change before update or delete on crm_audit
  for each row execute function crm_audit_append_only();

drop trigger if exists crm_audit_no_truncate on crm_audit;
create trigger crm_audit_no_truncate before truncate on crm_audit
  for each statement execute function crm_audit_append_only();

-- The mentorship board's own records. A person is named only by their opaque
-- key (server/crm/crypto.js); who they are lives in the sheets.

-- Where each mentor or mentee is in the selection, when the team has moved
-- them; without a row the board works it out from the sheets.
create table if not exists crm_people_state (
  person_key text not null,
  kind text not null check (kind in ('mentor', 'mentee')),
  status text not null,
  track text check (track in ('projects', 'orientation', 'both')),
  owner_id uuid references app_users(id) on delete set null,
  updated_by uuid references app_users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (person_key, kind)
);

-- The team's notes, encrypted (AES-256-GCM, bound to the person key).
create table if not exists crm_notes (
  id uuid primary key default gen_random_uuid(),
  person_key text not null,
  body_encrypted text not null,
  author_id uuid references app_users(id) on delete set null,
  author_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists crm_notes_person on crm_notes (person_key, created_at);

-- Mentor and mentee pairs. Ending one keeps the row (status 'ended').
create table if not exists crm_matches (
  id uuid primary key default gen_random_uuid(),
  mentor_key text not null,
  mentee_key text not null,
  track text not null check (track in ('projects', 'orientation')),
  status text not null default 'active' check (status in ('active', 'ended')),
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

-- A mentee has at most one active mentor; a pair is active at most once.
create unique index if not exists crm_matches_one_per_mentee
  on crm_matches (mentee_key) where status = 'active';
create unique index if not exists crm_matches_pair
  on crm_matches (mentor_key, mentee_key) where status = 'active';

-- ── Forms (/app/forms/, server/forms/) ──────────────────────────────────────

-- A form: who owns it, whether it takes answers, and its settings. The
-- questions are in form_versions; current_version is what the public sees.
create table if not exists forms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  settings jsonb not null default '{}',
  access_roles text[] not null default '{}',
  owner_id uuid references app_users(id) on delete set null,
  current_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The questions, per version: an answer keeps the version it was given to, so
-- changing a form never breaks the answers it already has.
create table if not exists form_versions (
  form_id uuid not null references forms(id) on delete cascade,
  version integer not null,
  schema jsonb not null,
  created_at timestamptz not null default now(),
  primary key (form_id, version)
);

-- The answers, encrypted (AES-256-GCM, bound to the form and the response).
-- respondent_key is the opaque key of the email given, when there is one.
create table if not exists form_responses (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms(id) on delete cascade,
  version integer not null,
  submitted_at timestamptz not null default now(),
  answers_encrypted text not null,
  respondent_key text,
  status text not null default 'new',
  assignee_id uuid references app_users(id) on delete set null,
  sheet_synced_at timestamptz,
  sheet_error text,
  deleted_at timestamptz
);

create index if not exists form_responses_form on form_responses (form_id, submitted_at);
create index if not exists form_responses_respondent on form_responses (form_id, respondent_key);

-- Each reviewer's scores for a response, and their note (encrypted).
create table if not exists form_reviews (
  response_id uuid not null references form_responses(id) on delete cascade,
  reviewer_key text not null,
  reviewer_name text not null,
  scores jsonb not null default '{}',
  note_encrypted text,
  updated_at timestamptz not null default now(),
  primary key (response_id, reviewer_key)
);

-- Public submissions, to limit them per address. The address is kept only as
-- an HMAC, and rows older than a day are deleted on every submission.
create table if not exists form_submit_attempts (
  ip_hash text not null,
  form_id uuid not null,
  at timestamptz not null default now()
);

create index if not exists form_submit_attempts_ip on form_submit_attempts (ip_hash, form_id, at);

-- ── Member applications (/app/members/, server/members.js) ───────────────────

-- One row per submission of the registration form. answers holds what the
-- form asked, as [{ label, value }], so the board shows any form as it is.
-- On approval the person gets join_token by email: following it links their
-- Discord account (discord_id) and adds them to the server with roles.
create table if not exists member_applications (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  requested_role text check (requested_role in ('participant', 'organizer')),
  answers jsonb not null default '[]',
  source text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  role text check (role in ('participant', 'organizer')),
  note text not null default '',
  decided_by uuid references app_users(id) on delete set null,
  decided_at timestamptz,
  join_token text unique,
  join_expires_at timestamptz,
  invite_sent_at timestamptz,
  invite_error text,
  discord_id text,
  discord_name text,
  joined_at timestamptz,
  join_error text,
  created_at timestamptz not null default now()
);

create index if not exists member_applications_created on member_applications (created_at);
`;
