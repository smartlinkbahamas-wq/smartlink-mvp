-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_quotations.sql and install_lead_trust.sql.

-- ---------------------------------------------------------------------------
-- Scheduled tasks
-- ---------------------------------------------------------------------------
-- The background runner's state, kept in Postgres rather than in memory.
--
-- Three problems this table solves, none of which an in-process timer can:
--
-- 1. Restarts. A setInterval loses its place on every deploy, so a daily job
--    would simply never run on a day the server was restarted.
--
-- 2. More than one instance. Two processes with the same timer both fire, and
--    a provider gets two copies of the same summary. The claim below is a
--    conditional UPDATE, so exactly one caller wins.
--
-- 3. Downtime catch-up. next_run_at is set forward from the moment a task
--    finishes, not from the slot it missed. After a day offline a daily task
--    runs once and then returns to its normal rhythm, instead of firing a
--    backlog of missed runs at once.
create table if not exists scheduled_tasks (
  task_key text primary key,

  -- How often the task wants to run. Stored rather than hardcoded so an
  -- administrator can slow something down without a deploy.
  interval_seconds integer not null check (interval_seconds >= 30),

  next_run_at timestamptz not null default now(),

  -- Claim. locked_by records which process holds it, so a stuck task can be
  -- traced to a specific instance rather than guessed at.
  locked_at timestamptz,
  locked_by text,

  last_run_at timestamptz,
  last_duration_ms integer,
  last_status text check (last_status in ('ok', 'error', 'skipped')),
  last_error text,
  -- What the run actually did, for the health endpoint: "3 reminders sent".
  last_detail text,

  run_count bigint not null default 0,
  error_count bigint not null default 0,

  -- An administrator can switch a task off without removing it.
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_scheduled_tasks_due
  on scheduled_tasks (next_run_at)
  where enabled;

-- ---------------------------------------------------------------------------
-- Claim a due task, atomically
-- ---------------------------------------------------------------------------
-- Returns the task only to the caller that wins the UPDATE. Everyone else
-- gets no row and moves on.
--
-- p_lock_timeout_seconds releases a task whose holder died mid-run. Without
-- it, one crash during a task would stop that task running ever again.
create or replace function claim_scheduled_task(
  p_task_key text,
  p_locked_by text,
  p_lock_timeout_seconds integer default 900
)
returns setof scheduled_tasks
language sql
as $$
  update scheduled_tasks
  set locked_at = now(),
      locked_by = p_locked_by,
      updated_at = now()
  where task_key = p_task_key
    and enabled
    and next_run_at <= now()
    and (
      locked_at is null
      or locked_at < now() - make_interval(secs => p_lock_timeout_seconds)
    )
  returning *;
$$;

-- ---------------------------------------------------------------------------
-- Release a task and schedule the next run
-- ---------------------------------------------------------------------------
-- next_run_at is computed from now(), deliberately. Advancing it by
-- interval_seconds from the previous slot would queue up every run missed
-- during downtime and fire them in a burst on restart.
create or replace function release_scheduled_task(
  p_task_key text,
  p_status text,
  p_duration_ms integer,
  p_detail text default null,
  p_error text default null
)
returns void
language sql
as $$
  update scheduled_tasks
  set locked_at = null,
      locked_by = null,
      last_run_at = now(),
      last_duration_ms = p_duration_ms,
      last_status = p_status,
      last_detail = p_detail,
      last_error = p_error,
      run_count = run_count + 1,
      error_count = error_count + (case when p_status = 'error' then 1 else 0 end),
      next_run_at = now() + make_interval(secs => interval_seconds),
      updated_at = now()
  where task_key = p_task_key;
$$;

-- ---------------------------------------------------------------------------
-- Quotation expiry reminders
-- ---------------------------------------------------------------------------
-- One reminder per quotation, so a provider is not emailed every tick about
-- the same document. Cleared when a quotation is re-sent or extended, because
-- the new window deserves its own reminder.
alter table quotations add column if not exists expiry_reminder_sent_at timestamptz;

create index if not exists idx_quotations_expiry_reminder
  on quotations (valid_until)
  where status = 'sent' and expiry_reminder_sent_at is null;

-- ---------------------------------------------------------------------------
-- Register the tasks
-- ---------------------------------------------------------------------------
-- Rows rather than code, so the runner discovers its work from the database
-- and an administrator can disable one without a deploy. Idempotent: the
-- conflict clause leaves an existing row's schedule and enabled flag alone.
insert into scheduled_tasks (task_key, interval_seconds) values
  -- Hourly. A quotation expiring tomorrow should prompt a reminder within the
  -- hour, not tomorrow.
  ('quotation_expiry_reminders', 3600),
  -- Every 15 minutes. The task itself decides whether a given provider is due
  -- a summary today, using notification_preferences.daily_summary_last_sent_at,
  -- so a frequent tick costs almost nothing and makes the send time flexible.
  ('daily_lead_summary', 900)
on conflict (task_key) do nothing;
