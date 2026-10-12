// Tables for the meeting polls. Every statement is idempotent so this can run
// on each cold start (see ensureSchema() in db.js). A change to an existing
// table needs an `alter table ... add column if not exists` here, not an edit
// of the `create table` — databases that already exist never re-run it.

module.exports = `
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
`;
