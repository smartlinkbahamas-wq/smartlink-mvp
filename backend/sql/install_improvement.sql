-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_support.sql and install_jobs.sql.

-- ---------------------------------------------------------------------------
-- Continual improvement register
-- ---------------------------------------------------------------------------
-- The fields specified: reference, date identified, source, description,
-- category, possible root cause, corrective action, assignee, target date,
-- status, actual completion, effectiveness review.
--
-- The governing rule: NOT EVERY TICKET CREATES AN ACTION. The system surfaces
-- candidates and counts how often the same thing recurs; a person decides
-- whether it is worth acting on. A register that opens an entry for every
-- complaint becomes a list nobody reads, which is worse than no register.
create table if not exists improvement_actions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,

  identified_on date not null default current_date,

  -- Where it came from. Open text within a checked set, so the sources can be
  -- extended without a migration to the rows already recorded.
  source text not null check (source in (
    'complaint',
    'dispute',
    'unverifiable_job',
    'provider_feedback',
    'customer_feedback',
    'internal_review',
    'other'
  )),

  -- What prompted it, where there is a specific thing. All nullable: an
  -- entry may come from a pattern rather than one incident.
  source_ticket_id uuid references support_tickets(id) on delete set null,
  source_job_id uuid references jobs(id) on delete set null,

  description text not null,
  category text,
  possible_root_cause text,

  corrective_action text,
  assigned_to_user_id uuid,
  assigned_to_name text,
  target_date date,

  status text not null default 'open' check (status in (
    'open',
    'in_progress',
    'completed',
    'cancelled'
  )),

  completed_on date,

  -- Reviewed after the fact: did the action actually work? An improvement
  -- register with no effectiveness review is a list of good intentions.
  effectiveness_review text,
  effectiveness_reviewed_on date,
  was_effective boolean,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint improvement_description_not_blank check (length(btrim(description)) > 0),

  -- A completed entry has to say when, and what was actually done. "Completed"
  -- with no corrective action recorded cannot be reviewed for effectiveness.
  constraint improvement_completion_recorded check (
    status <> 'completed'
    or (completed_on is not null and corrective_action is not null)
  ),

  -- An effectiveness verdict requires the review text behind it.
  constraint improvement_effectiveness_has_review check (
    was_effective is null or effectiveness_review is not null
  )
);

create index if not exists idx_improvement_status
  on improvement_actions (status, target_date);
create index if not exists idx_improvement_open
  on improvement_actions (identified_on desc)
  where status in ('open', 'in_progress');
create index if not exists idx_improvement_source_ticket
  on improvement_actions (source_ticket_id)
  where source_ticket_id is not null;

-- ---------------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------------
create table if not exists improvement_counter (
  id boolean primary key default true check (id),
  next_number integer not null default 1,
  updated_at timestamptz not null default now()
);

insert into improvement_counter (id) values (true) on conflict (id) do nothing;

create or replace function next_improvement_number()
returns integer
language plpgsql
as $$
declare
  v_number integer;
begin
  update improvement_counter
  set next_number = next_number + 1,
      updated_at = now()
  where id = true
  returning next_number - 1 into v_number;

  return v_number;
end;
$$;
