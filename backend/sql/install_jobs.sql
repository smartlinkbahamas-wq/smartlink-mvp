-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_business_foundations.sql and install_pipeline_stage_events.sql.

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
-- Work a provider has actually been awarded.
--
-- This closes the funnel. Until now the platform could say an introduction was
-- accepted but nothing about whether it became paid work, which is the
-- question asked in every round of feedback: how many inquiries turn into
-- jobs. A job row is the answer's denominator.
--
-- Stage transitions are NOT recorded here. pipeline_stage_events already
-- exists, is append-only, and its subject_type was left as open text
-- specifically so quotations, jobs and invoices could share it. A second
-- history table would mean two places to look and two chances to disagree.
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  job_number integer not null,
  reference text not null,

  quotation_id uuid references quotations(id) on delete set null,
  lead_id uuid references lead_submissions(id) on delete set null,
  introduction_request_id uuid references introduction_requests(id) on delete set null,
  service_menu_item_id uuid,

  customer_name text not null,
  customer_email text,
  customer_phone text,

  job_name text not null,
  description text,

  agreed_price numeric(10, 2),
  currency text not null default 'USD',

  -- Recorded at creation and never changed.
  --
  -- Without it, a provider who enters their own existing customers inflates
  -- the platform's apparent conversion, and administrative reporting cannot
  -- separate work SmartLink produced from work it merely recorded. Reporting
  -- that cannot make that distinction is not worth running.
  source text not null check (source in ('smartlink', 'provider_entered')),

  status text not null default 'awarded' check (status in (
    'awarded',
    'scheduled',
    'in_progress',
    'delayed',
    'provider_completed',
    'customer_confirmed',
    'disputed',
    'cancelled',
    'unverifiable'
  )),

  -- Mandatory before work starts, enforced below rather than in the form.
  expected_completion_date date,
  original_expected_completion_date date,
  actual_completion_date date,
  completion_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint jobs_number_per_expert unique (expert_id, job_number),
  constraint jobs_job_name_not_blank check (length(btrim(job_name)) > 0),
  constraint jobs_price_not_negative check (agreed_price is null or agreed_price >= 0),

  -- An expected completion date is required once work is in progress. The
  -- monitoring schedule, the overdue dashboard and every timeliness figure are
  -- computed from this date; a job in progress without one is invisible to all
  -- of them.
  constraint jobs_in_progress_needs_date check (
    status <> 'in_progress' or expected_completion_date is not null
  ),

  -- A completed job has to say when. "Completed, date unknown" cannot be
  -- reported on and cannot be disputed fairly.
  constraint jobs_completion_needs_date check (
    status not in ('provider_completed', 'customer_confirmed')
    or actual_completion_date is not null
  )
);

create index if not exists idx_jobs_expert
  on jobs (expert_id, created_at desc);
create index if not exists idx_jobs_status
  on jobs (expert_id, status);
create index if not exists idx_jobs_source
  on jobs (source, created_at desc);
create index if not exists idx_jobs_quotation
  on jobs (quotation_id)
  where quotation_id is not null;
-- Drives the overdue view: work that should be finished and is not.
create index if not exists idx_jobs_expected_completion
  on jobs (expected_completion_date)
  where status in ('scheduled', 'in_progress', 'delayed');

-- ---------------------------------------------------------------------------
-- Date revisions
-- ---------------------------------------------------------------------------
-- Every change to an expected completion date, with the reason.
--
-- Revisions are free before work starts and require administrator approval
-- afterwards. The original date, every revision, the reasons and the approval
-- history are all retained -- that was specified, and it is also the only way
-- a timeliness figure can be defended if a provider disputes it.
create table if not exists job_date_revisions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  expert_id text not null references experts(expert_id) on delete cascade,

  previous_date date,
  requested_date date not null,
  reason text not null,

  -- 'auto' for a revision made before work started, which needs no review.
  approval_status text not null default 'pending'
    check (approval_status in ('auto', 'pending', 'approved', 'rejected')),
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  review_notes text,

  created_at timestamptz not null default now(),

  constraint job_date_revisions_reason_not_blank check (length(btrim(reason)) > 0)
);

create index if not exists idx_job_date_revisions_job
  on job_date_revisions (job_id, created_at desc);
create index if not exists idx_job_date_revisions_pending
  on job_date_revisions (approval_status, created_at)
  where approval_status = 'pending';
