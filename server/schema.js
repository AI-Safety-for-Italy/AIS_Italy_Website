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

-- Sharing a poll, as a form's answers are shared: the Discord roles
-- ([{ id, name }]) and the people by name ([{ discordId, name }]) who see it
-- and its answers (not the voters' emails, and changing nothing), and each
-- one's own choice about hearing of new answers ({ discordId: true|false }).
alter table polls add column if not exists share_roles jsonb not null default '[]';
alter table polls add column if not exists share_people jsonb not null default '[]';
alter table polls add column if not exists notify_choices jsonb not null default '{}';

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

-- Keys given to one person by name, on top of their roles' (server/permissions.js).
create table if not exists user_permissions (
  user_id uuid primary key references app_users(id) on delete cascade,
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

-- Raised to end every session of a user (server/auth.js): on sign-out, and
-- when they are no longer in the Discord server.
alter table app_users add column if not exists session_version integer not null default 0;

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

-- A mentor's draft for the public site: bio, a 400x400 JPEG, consent and the
-- entry being written, encrypted together.
create table if not exists crm_site_profiles (
  person_key text primary key,
  data_encrypted text not null,
  updated_by uuid references app_users(id) on delete set null,
  updated_by_name text,
  updated_at timestamptz not null default now()
);

-- A mentor's entry as published on /mentorship/ from the board: public data,
-- so in clear. id is the entry's id there; a hidden row takes the
-- data/mentors.yaml entry of that id off the site. photo is the JPEG in
-- base64, kept only with the mentor's consent.
create table if not exists mentor_site_entries (
  id text primary key,
  person_key text,
  entry jsonb not null,
  photo text,
  photo_hash text,
  hidden boolean not null default false,
  published_by uuid references app_users(id) on delete set null,
  published_by_name text,
  published_at timestamptz not null default now()
);

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

-- Who applied, kept encrypted like the form answers (server/crm/crypto.js):
-- details_encrypted holds { name, email, answers }, bound to the row's id.
-- email_key, an opaque HMAC of the email, finds someone who applied twice.
-- The plain name, email and answers columns stay empty.
alter table member_applications add column if not exists details_encrypted text;
alter table member_applications add column if not exists email_key text;
alter table member_applications alter column name drop not null;
alter table member_applications alter column email drop not null;
create index if not exists member_applications_email_key on member_applications (email_key);

-- join_token holds the SHA-256 of the link's token, never the token itself:
-- the database alone cannot let anyone in. join_email_match: whether the
-- Discord account that used the link has the application's email (null when
-- Discord did not say).
alter table member_applications add column if not exists join_email_match boolean;

-- The people on the mentorship board (server/crm/records.js): one row per
-- answer, in the shape server/crm/sources.js gives a sheet's row, encrypted
-- and bound to the row's id. origin: 'import' (copied once from a Google
-- sheet), 'form' (an answer to a form linked to the board: it goes when the
-- answer goes) or 'board' (added by hand). person_key joins the lists.
create table if not exists crm_records (
  id uuid primary key,
  source text not null,
  person_key text,
  origin text not null check (origin in ('import', 'form', 'board')),
  response_id uuid references form_responses(id) on delete cascade,
  data_encrypted text not null,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists crm_records_source on crm_records (source, origin);
-- One person's records (opening them, changing their stage).
create index if not exists crm_records_person on crm_records (person_key);

-- What a member follows (server/follows.js): told about it, counted on their
-- home page. Topics: 'members' (the member applications board).
create table if not exists app_follows (
  user_id uuid not null references app_users(id) on delete cascade,
  topic text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, topic)
);

-- The community (server/community.js): the working groups, each with its
-- Discord role, which are tags on people and never permissions here; the
-- members (approved on the board, or imported once from the old sheet), their
-- details encrypted like an application's; and which group each is in, with
-- the level they take part at. The site's directory and its working groups
-- are built from these (/api/community), once switched on.
create table if not exists work_groups (
  id text primary key,
  title_en text not null,
  title_it text not null,
  description_en text not null default '',
  description_it text not null default '',
  discord_role_id text not null,
  sheet_column text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into work_groups (id, title_en, title_it, description_en, description_it, discord_role_id, sheet_column, position) values
  ('mentorship', 'Mentorship', 'Mentorship', 'Runs the mentorship program: matches newcomers with experienced members and supports each cohort.', 'Gestisce il programma di mentorship: abbina chi inizia a membri esperti e segue ogni gruppo.', '1566885628547960922', 'Programma di mentorship', 1),
  ('governance-and-funding', 'Governance & funding', 'Governance e fundraising', 'Legal structure, finances, grants and relationships with funders.', 'Struttura legale, finanze, bandi e rapporti con i finanziatori.', '1566885774173933578', 'Governance, fundraising e finanze', 2),
  ('seminars', 'Seminars', 'Seminari', 'The research seminar series: speakers, schedule and streaming.', 'Il ciclo di seminari di ricerca: relatori, calendario e streaming.', '1566885852347633766', 'Seminari', 3),
  ('technical', 'Technical infrastructure', 'Infrastruttura tecnica', 'The website, internal tools and the Discord server.', 'Il sito, gli strumenti interni e il server Discord.', '1566885921062658079', 'Infrastruttura tecnica', 4),
  ('education', 'Education & outreach', 'Didattica e divulgazione', 'Courses, reading groups and learning materials on AI safety.', 'Corsi, gruppi di lettura e materiali didattici sull''AI safety.', '1566886054810615918', 'Didattica e divulgazione', 5),
  ('communications', 'Communications', 'Comunicazione', 'Newsletter, social media, press and the public voice of the organisation.', 'Newsletter, social, stampa e la voce pubblica dell''associazione.', '1566886132887724132', 'Comunicazione', 6),
  ('community', 'Community & networking', 'Comunità e networking', 'Welcomes new members and keeps the community connected, online and in the city groups.', 'Accoglie i nuovi membri e tiene unita la community, online e nei gruppi cittadini.', '1566887710659051550', 'Comunità e networking', 7),
  ('events', 'Events', 'Eventi', 'Organises meetups and events across Italy.', 'Organizza meetup ed eventi in tutta Italia.', '1566887735308845169', 'Eventi', 8)
on conflict (id) do nothing;

create table if not exists community_members (
  id uuid primary key,
  person_key text unique,
  discord_id text unique,
  role text not null default 'participant' check (role in ('participant', 'organizer')),
  publish boolean not null default false,
  details_encrypted text not null,
  source text not null check (source in ('sheet', 'application', 'board')),
  joined_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists member_groups (
  member_id uuid not null references community_members(id) on delete cascade,
  group_id text not null references work_groups(id) on delete cascade,
  level text not null check (level in ('coordination', 'stable')),
  primary key (member_id, group_id)
);

-- On an application: the tags chosen for the person ([{ group, level }]), and
-- whether it asks to join or, from a participant, to become an organizer.
alter table member_applications add column if not exists tags jsonb not null default '[]';
alter table member_applications add column if not exists kind text not null default 'join';

-- The form answer an application came from, so the board's decision shows
-- as the answer's tag (Approved, Rejected).
alter table member_applications add column if not exists response_id uuid;

-- ── The mentee selection (/app/review/, server/crm/review.js) ──────────────

-- Who may score the mentees: people picked by the panel's admins (holders of
-- review_admin). A reviewer sees only the anonymous applications and their
-- own scores, never the others' nor the summary.
create table if not exists review_reviewers (
  user_id uuid primary key references app_users(id) on delete cascade,
  added_by_name text not null,
  added_at timestamptz not null default now()
);

-- One reviewer's scores of one mentee, on the CV or on the answers: the grid's
-- criterion -> 1..5. conflict: they know the person and step aside. The
-- comment is encrypted, bound to the person, the part and the reviewer.
create table if not exists review_scores (
  person_key text not null,
  part text not null check (part in ('cv', 'answers')),
  reviewer_id uuid not null references app_users(id) on delete cascade,
  reviewer_name text not null,
  scores jsonb not null default '{}',
  conflict boolean not null default false,
  comment_encrypted text,
  updated_at timestamptz not null default now(),
  primary key (person_key, part, reviewer_id)
);

-- The community's members and working groups got a permission of their own
-- (community), apart from the applications (members). Once, on each
-- database: whoever held members then keeps both. Later changes are the
-- Permissions page's.
do $$
begin
  if not exists (select 1 from app_settings where key = 'migration_community_key') then
    update content_role_permissions set permissions = array_append(permissions, 'community')
      where 'members' = any(permissions) and not ('community' = any(permissions));
    update user_permissions set permissions = array_append(permissions, 'community')
      where 'members' = any(permissions) and not ('community' = any(permissions));
    insert into app_settings (key, value) values ('migration_community_key', 'true');
  end if;
end $$;

-- Linking the members to their Discord accounts (server/community.js): who
-- they are there (username, display name) and a note, encrypted; and
-- whether someone checked they are not on Discord at all.
alter table community_members add column if not exists discord_info_encrypted text;
alter table community_members add column if not exists discord_absent boolean not null default false;

-- A difference between a member's tags and their roles on Discord that the
-- team looked at and left as it is: a role without the tag (extra), or a tag
-- without the role (missing). The check no longer lists it.
create table if not exists member_role_ok (
  member_id uuid not null references community_members(id) on delete cascade,
  group_id text not null references work_groups(id) on delete cascade,
  kind text not null check (kind in ('missing', 'extra')),
  primary key (member_id, group_id, kind)
);

-- The association's role (Partecipante, Organizzatore) on Discord against
-- the member's role here, a difference the team left as it is: missing (no
-- such role there) or differs (the other one there). Not listed again.
create table if not exists member_main_role_ok (
  member_id uuid not null references community_members(id) on delete cascade,
  kind text not null check (kind in ('missing', 'differs')),
  primary key (member_id, kind)
);

-- Someone on the Discord server with neither role and not on the board, whom
-- the team looked at and left as they are (a bot's owner, a guest): not
-- listed again.
create table if not exists discord_no_role_ok (
  discord_id text primary key,
  created_at timestamptz not null default now()
);

-- Who coordinates a working group is chosen on Working groups only. Once, on
-- each database: the coordination people declared on the forms and the old
-- sheet becomes taking part, so the coordinators are set from there.
do $$
begin
  if not exists (select 1 from app_settings where key = 'migration_coordinators') then
    update member_groups set level = 'stable' where level = 'coordination';
    insert into app_settings (key, value) values ('migration_coordinators', 'true');
  end if;
end $$;

-- Where each of a member's fields last came from ({ field: { source, at } },
-- server/member-merge.js): an import or an application fills gaps and newer
-- answers, never what the board set.
alter table community_members add column if not exists field_sources jsonb not null default '{}';

-- What a member came from, kept as it was: the old sheet's rows, encrypted and
-- bound to theirs. Keyed by the row's hash: the same sheet again adds nothing.
-- (Applications are read from member_applications, not copied.)
create table if not exists member_sources (
  id uuid primary key,
  member_id uuid not null references community_members(id) on delete cascade,
  kind text not null check (kind in ('sheet')),
  ref text not null,
  answers_encrypted text not null,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  unique (member_id, kind, ref)
);

-- A role the board took away from a member (out of a group, made a
-- participant): to take off on Discord when the team applies the changes.
-- Gone once taken off, or when the tag is back.
create table if not exists discord_removals (
  member_id uuid not null references community_members(id) on delete cascade,
  role_id text not null,
  created_at timestamptz not null default now(),
  primary key (member_id, role_id)
);

-- The Discord role of a working group removed, or given another role: whoever
-- still holds it there is listed, to take it off.
create table if not exists discord_retired_roles (
  role_id text primary key,
  group_id text not null,
  title text not null,
  retired_at timestamptz not null default now()
);

-- A member who left the association (offboarded): kept as a record, off the
-- website, every role of theirs on Discord listed to take off. Restored, they
-- are a member again. archive_note says why, encrypted with their details.
alter table community_members add column if not exists archived_at timestamptz;
alter table community_members add column if not exists archive_note_encrypted text;

-- The members merged into this one (two records of the same person): their
-- history stays theirs on the audit trail, so it is read under these ids too.
alter table community_members add column if not exists merged_ids text[] not null default '{}';

-- Two members of the same name the team said are not the same person: not
-- offered for merging again. a < b.
create table if not exists member_not_duplicates (
  a uuid not null references community_members(id) on delete cascade,
  b uuid not null references community_members(id) on delete cascade,
  primary key (a, b)
);

-- The team's notes about a member, for the team only: encrypted, bound to the
-- note. Only their author removes them; they go with the member.
create table if not exists member_notes (
  id uuid primary key,
  member_id uuid not null references community_members(id) on delete cascade,
  author_id uuid,
  author_name text not null,
  body_encrypted text not null,
  created_at timestamptz not null default now()
);
create index if not exists member_notes_member on member_notes (member_id, created_at);

-- The local groups (server/local-groups.js): one per city, on their own board
-- (local_groups). Who leads each, their contacts, the WhatsApp link and the
-- notes are encrypted, bound to the row (details_encrypted, null until set).
-- What the community page's map shows of each is apart and public: shown or
-- not, its pin (x/y in the map's 0 0 420 560 viewBox) and its link, set from
-- Site content → Local groups (local_groups_site) and published from there.
create table if not exists local_groups (
  id uuid primary key,
  city text not null,
  status text not null default 'starting' check (status in ('starting', 'active', 'paused')),
  details_encrypted text,
  site_show boolean not null default false,
  site_link text not null default '',
  map_x real,
  map_y real,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_name text
);

create unique index if not exists local_groups_city on local_groups (lower(city));

-- Once, on each database: the cities of data/community.yaml start the board,
-- on the map where they are, so publishing first changes nothing on the site.
do $$
begin
  if not exists (select 1 from app_settings where key = 'migration_local_groups_seed') then
    insert into local_groups (id, city, status, site_show, map_x, map_y) values
      (gen_random_uuid(), 'Genova', 'active', true, 90.6, 175.2),
      (gen_random_uuid(), 'Milano', 'active', true, 98.7, 125.8),
      (gen_random_uuid(), 'Padova', 'active', true, 187.5, 128.5),
      (gen_random_uuid(), 'Torino', 'active', true, 49.0, 144.3),
      (gen_random_uuid(), 'Trento', 'active', true, 162.5, 97.2),
      (gen_random_uuid(), 'Trieste', 'active', true, 250.3, 117.0),
      (gen_random_uuid(), 'Udine', 'active', true, 232.4, 97.0)
    on conflict do nothing;
    insert into app_settings (key, value) values ('migration_local_groups_seed', 'true');
  end if;
end $$;

-- ── Calendar (/app/calendar/, server/calendars.js) ───────────────────────────

-- The sub-calendars. Each has three levels of access, each given to every
-- member (<level>_all), to Discord roles ([{ id, name }]) and to people by
-- name ([{ discordId, name }]): view sees the events, edit also creates and
-- changes every event, manage also changes the calendar itself and who has
-- access. A public calendar is also seen by anyone, signed in or not, on
-- /calendar/ and through its fixed .ics link. announce: the Discord channels
-- its events are announced in by default ([{ channelId, name, minutes: [] }]).
-- system_key marks the two the site's content feeds (seminars, events).
create table if not exists calendars (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  color text not null default '#00703a',
  timezone text not null default 'Europe/Rome',
  is_public boolean not null default false,
  view_all boolean not null default false,
  view_roles jsonb not null default '[]',
  view_people jsonb not null default '[]',
  edit_all boolean not null default false,
  edit_roles jsonb not null default '[]',
  edit_people jsonb not null default '[]',
  manage_all boolean not null default false,
  manage_roles jsonb not null default '[]',
  manage_people jsonb not null default '[]',
  announce jsonb not null default '[]',
  owner_id uuid references app_users(id) on delete set null,
  system_key text unique,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The events. Times are instants; an all-day event runs from the midnight
-- (UTC) of its first day to the one after its last, read as dates. A
-- repeating event has its rule (recurrence.js) and the starts it skips
-- (exdates, ISO strings); an occurrence changed on its own is a row of its
-- own, pointing at its series (series_id) and at the start it replaces
-- (recurrence_id). reminders: [{ minutes, channels: ['discord', 'email'] }],
-- chosen by whoever writes the event; announce: the Discord channels it is
-- announced in, null for its calendar's. An event copied from a seminar or
-- event of the site, or from a poll's chosen time, says so in source and
-- source_id, and is changed there only.
create table if not exists calendar_events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars(id) on delete cascade,
  title text not null,
  description text not null default '',
  location text not null default '',
  video_kind text check (video_kind in ('link', 'discord')),
  video_url text not null default '',
  discord_channel_id text,
  discord_channel_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  timezone text not null default 'Europe/Rome',
  recurrence jsonb,
  exdates jsonb not null default '[]',
  series_id uuid references calendar_events(id) on delete cascade,
  recurrence_id timestamptz,
  reminders jsonb not null default '[]',
  announce jsonb,
  source text check (source in ('content', 'poll')),
  source_id text,
  sequence integer not null default 0,
  created_by uuid references app_users(id) on delete set null,
  updated_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_events_calendar on calendar_events (calendar_id, starts_at);
create index if not exists calendar_events_series on calendar_events (series_id);
create unique index if not exists calendar_events_source on calendar_events (source, source_id);

-- Who comes to an occurrence of an event: going, maybe or no.
create table if not exists calendar_rsvps (
  event_id uuid not null references calendar_events(id) on delete cascade,
  occurrence_start timestamptz not null,
  user_id uuid not null references app_users(id) on delete cascade,
  answer text not null check (answer in ('yes', 'maybe', 'no')),
  updated_at timestamptz not null default now(),
  primary key (event_id, occurrence_start, user_id)
);

-- Each member's choices: which calendars show on the dashboard, go into their
-- personal .ics link (feed_token) and send them reminders. selection:
-- { calendarId: { dashboard, ics, notify } }; a calendar not in it follows
-- the defaults (calendars.js, defaultChoice). advanced: one switch per calendar
-- and column; else the dashboard and the link go together and notify
-- applies to the same calendars.
create table if not exists calendar_prefs (
  user_id uuid primary key references app_users(id) on delete cascade,
  feed_token text not null unique,
  advanced boolean not null default false,
  notify boolean not null default false,
  selection jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- The reminders and announcements sent, so none goes twice: to a person
-- (user_id) or in a Discord channel (channel_id).
create table if not exists calendar_reminders_sent (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references calendar_events(id) on delete cascade,
  occurrence_start timestamptz not null,
  minutes integer not null,
  user_id uuid references app_users(id) on delete cascade,
  channel_id text,
  sent_at timestamptz not null default now()
);

create unique index if not exists calendar_reminders_once on calendar_reminders_sent
  (event_id, occurrence_start, minutes, coalesce(user_id::text, ''), coalesce(channel_id, ''));

-- Which calendar a seminar or event of the site lands in: null for the
-- default one of its type, 'none' for none, else a calendar's id.
alter table content_items add column if not exists calendar_choice text;

-- The calendar a poll's chosen time lands in, if any.
alter table polls add column if not exists calendar_id uuid references calendars(id) on delete set null;

-- Once, on each database: the two calendars the site's seminars and events
-- feed, public, managed by whoever holds calendar_admin.
do $$
begin
  if not exists (select 1 from app_settings where key = 'migration_calendar_defaults') then
    insert into calendars (slug, name, description, color, is_public, view_all, system_key) values
      ('seminars', 'Seminars', 'The seminars of AI Safety for Italy.', '#00703a', true, true, 'seminars'),
      ('events', 'Events', 'The events of AI Safety for Italy.', '#2563eb', true, true, 'events')
    on conflict do nothing;
    insert into app_settings (key, value) values ('migration_calendar_defaults', 'true');
  end if;
end $$;
`;
