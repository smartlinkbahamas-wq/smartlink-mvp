-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_jobs.sql, install_scheduler.sql and
-- install_business_foundations.sql (for secure_links).

-- ---------------------------------------------------------------------------
-- Monitoring timeframes
-- ---------------------------------------------------------------------------
-- The schedule, as settings rather than constants in code: "timeframes
-- configurable, not hardcoded" was explicit, and these are the numbers most
-- likely to need tuning once real jobs are flowing.
--
-- A single-row table. The boolean primary key with a check that it is true is
-- the standard way to guarantee exactly one row -- a second insert collides on
-- the primary key, so there can never be two competing sets of settings.
create table if not exists job_monitoring_settings (
  id boolean primary key default true check (id),

  -- Before the expected completion date: remind the provider.
  provider_reminder_days_before integer not null default 2,
  -- On the date: ask the customer to confirm completion.
  completion_request_days_after integer not null default 0,
  -- After the date, still not complete: remind the provider again.
  overdue_reminder_days_after integer not null default 2,
  -- Still nothing: tell an administrator.
  admin_notify_days_after integer not null default 3,
  -- Still nothing: escalate.
  escalation_days_after integer not null default 7,

  -- No customer confirmation after this many days -> administrator telephones.
  unverifiable_after_days integer not null default 7,
  -- Telephone attempts required before a job may be marked Unverifiable.
  required_phone_attempts integer not null default 2,

  -- One extra automated reminder before the telephone stage. Recommended as a
  -- softening of the administrator bottleneck: the calls are an operating cost
  -- that grows with volume, and software can prompt before a person has to.
  send_extra_reminder_before_calls boolean not null default true,

  updated_at timestamptz not null default now(),

  constraint job_monitoring_settings_order check (
    overdue_reminder_days_after <= admin_notify_days_after
    and admin_notify_days_after <= escalation_days_after
  ),
  constraint job_monitoring_settings_positive check (
    provider_reminder_days_before >= 0
    and completion_request_days_after >= 0
    and overdue_reminder_days_after >= 0
    and unverifiable_after_days > 0
    and required_phone_attempts > 0
  )
);

insert into job_monitoring_settings (id) values (true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Monitoring trail
-- ---------------------------------------------------------------------------
-- Which notices have gone out for which job.
--
-- The unique index is the whole mechanism: one notice of each kind per job, so
-- the scheduler can run every hour without emailing the same provider about
-- the same late job repeatedly. Reminder fatigue is the single most likely
-- reason providers would mute everything, which would defeat the point.
--
-- Rows are deleted when a job's date is legitimately revised, so the new
-- deadline earns its own set of notices.
create table if not exists job_monitoring_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,

  event_type text not null check (event_type in (
    'provider_reminder',
    'completion_request',
    'overdue_reminder',
    'extra_reminder',
    'admin_notified',
    'escalated',
    'unverifiable_notice'
  )),

  sent_to text,
  detail text,
  created_at timestamptz not null default now(),

  constraint job_monitoring_events_once unique (job_id, event_type)
);

create index if not exists idx_job_monitoring_events_job
  on job_monitoring_events (job_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Customer completion confirmation
-- ---------------------------------------------------------------------------
-- The four options specified, and nothing that lets silence count as a yes.
--
-- One row per job: a customer answers once. Changing their mind is a dispute,
-- which an administrator handles, not a second confirmation.
create table if not exists job_completion_confirmations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references jobs(id) on delete cascade,

  outcome text not null check (outcome in (
    'completed_satisfactorily',
    'completed_with_concerns',
    'partially_completed',
    'not_completed'
  )),

  comments text,
  -- 'secure_link' today. Recorded so a confirmation always carries evidence of
  -- how the customer was identified.
  verification_method text not null default 'secure_link',
  secure_link_id uuid references secure_links(id) on delete set null,
  -- Whether the customer asked for help. Concerns, partial and not-completed
  -- all offer it.
  support_requested boolean not null default false,

  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Telephone verification attempts
-- ---------------------------------------------------------------------------
-- The Unverifiable workflow, exactly as specified: no confirmation after the
-- configured window, administrator telephones, and after the required number
-- of attempts with no response the job is marked Unverifiable with both
-- attempt dates retained.
--
-- A table rather than two date columns, because "two attempts" is a current
-- setting rather than a law, and because the outcome of each call matters --
-- reaching someone who confirms is a different result from no answer.
create table if not exists job_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,

  attempt_number integer not null check (attempt_number > 0),
  attempted_at timestamptz not null default now(),

  outcome text not null check (outcome in (
    'no_answer',
    'voicemail',
    'wrong_number',
    'reached_confirmed',
    'reached_disputed',
    'reached_no_comment'
  )),

  notes text,
  recorded_by_user_id uuid,
  created_at timestamptz not null default now(),

  constraint job_verification_attempts_unique unique (job_id, attempt_number)
);

create index if not exists idx_job_verification_attempts_job
  on job_verification_attempts (job_id, attempt_number);

-- ---------------------------------------------------------------------------
-- Administrator notes on a job
-- ---------------------------------------------------------------------------
-- Follow-up actions, recorded as internal notes.
--
-- A separate table rather than a column on jobs, because internal must be
-- structurally internal: a note that lives on the job row will eventually be
-- returned by a `select *` that reaches a provider or a customer. Nothing
-- selects from this table except the administrator endpoints.
create table if not exists job_admin_notes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  note text not null,
  author_user_id uuid,
  created_at timestamptz not null default now(),

  constraint job_admin_notes_not_blank check (length(btrim(note)) > 0)
);

create index if not exists idx_job_admin_notes_job
  on job_admin_notes (job_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Register the monitoring task
-- ---------------------------------------------------------------------------
-- Hourly. The task works out what each job is due from the settings above, so
-- the tick rate only affects how promptly a notice goes out, not which notices
-- are sent.
insert into scheduled_tasks (task_key, interval_seconds) values
  ('job_monitoring', 3600)
on conflict (task_key) do nothing;

-- ---------------------------------------------------------------------------
-- Completion confirmation links
-- ---------------------------------------------------------------------------
-- secure_links already restricts purpose to a fixed set. 'completion_confirmation'
-- is in that set, so no change is needed here -- noted explicitly so nobody
-- goes looking for a missing migration.
