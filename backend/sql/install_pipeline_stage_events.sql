-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Creates pipeline_stage_events and backfills it from existing rows.

-- Every stage an inquiry passes through, with the time it got there.
--
-- Why this table exists: introduction_requests carries a single `status`
-- column that is overwritten on every change, and the row has only
-- created_at. So the platform can say what state an inquiry is in now, but
-- not when it got there and never how long it took. That makes the
-- conversion reporting the business actually needs — how many inquiries
-- became quotations, awarded jobs and completed work — uncomputable.
--
-- This is append-only. A row is written on every transition and nothing
-- updates or deletes one, so the history is the source of truth and the
-- `status` column on introduction_requests becomes a convenience cache of
-- the latest event.
--
-- subject_type is deliberately open text rather than a check constraint:
-- the same table will carry quotation, job and invoice stages later, and a
-- constraint here would need a migration for each.
create table if not exists pipeline_stage_events (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  -- Denormalised so the reporting queries never need a join to attribute an
  -- event to a provider or the originating inquiry.
  expert_id text references experts(expert_id) on delete set null,
  lead_id uuid references lead_submissions(id) on delete set null,
  from_stage text,
  to_stage text not null,
  -- Who caused it: 'expert' | 'customer' | 'admin' | 'system'.
  actor_type text not null default 'system',
  actor_user_id uuid,
  notes text,
  -- Where the work came from, recorded at the point the event is written so
  -- it can never be inferred wrongly later.
  source text not null default 'smartlink',
  created_at timestamptz not null default now()
);

create index if not exists idx_pipeline_stage_events_subject
  on pipeline_stage_events (subject_type, subject_id, created_at);
create index if not exists idx_pipeline_stage_events_expert
  on pipeline_stage_events (expert_id, created_at desc);
create index if not exists idx_pipeline_stage_events_stage
  on pipeline_stage_events (to_stage, created_at desc);

-- Backfill: give every existing introduction request its 'submitted' event so
-- the funnel has a complete denominator from day one. created_at is the only
-- timestamp those rows carry, so it is the honest value to use.
-- Idempotent — re-running inserts nothing new.
insert into pipeline_stage_events (subject_type, subject_id, expert_id, lead_id, from_stage, to_stage, actor_type, source, created_at)
select 'introduction_request', ir.id, ir.expert_id, ir.lead_id, null, 'submitted', 'system', 'smartlink', ir.created_at
from introduction_requests ir
where not exists (
  select 1 from pipeline_stage_events e
  where e.subject_type = 'introduction_request'
    and e.subject_id = ir.id
    and e.to_stage = 'submitted'
);

-- Backfill the current status as a second event where it has moved past
-- 'submitted'. The real transition time is unknown and is NOT invented here —
-- created_at is reused and the note says so, so nobody later reads these as
-- measured timings.
insert into pipeline_stage_events (subject_type, subject_id, expert_id, lead_id, from_stage, to_stage, actor_type, notes, source, created_at)
select 'introduction_request', ir.id, ir.expert_id, ir.lead_id, 'submitted', ir.status, 'system',
       'Backfilled: original transition time was not recorded.', 'smartlink', ir.created_at
from introduction_requests ir
where ir.status is not null
  and ir.status <> 'submitted'
  and not exists (
    select 1 from pipeline_stage_events e
    where e.subject_type = 'introduction_request'
      and e.subject_id = ir.id
      and e.to_stage = ir.status
  );
