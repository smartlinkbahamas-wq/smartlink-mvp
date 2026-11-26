-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_jobs.sql, install_job_monitoring.sql and install_scheduler.sql.

-- ---------------------------------------------------------------------------
-- Customer satisfaction survey
-- ---------------------------------------------------------------------------
-- Asked on the same screen as the completion confirmation, so the customer
-- gets one message rather than two. Two separate emails would halve the
-- response rate on both.
--
-- Only the overall rating is required. The five-part breakdown, the yes/no
-- questions and the comment are all optional: a survey that demands nine
-- answers is a survey most people abandon, and a confirmation with one rating
-- is worth far more than a perfect form nobody finishes.
create table if not exists customer_satisfaction_surveys (
  id uuid primary key default gen_random_uuid(),
  -- One per job. A customer answers once; changing their mind is a dispute.
  job_id uuid not null unique references jobs(id) on delete cascade,
  expert_id text references experts(expert_id) on delete set null,

  overall_rating smallint not null check (overall_rating between 1 and 5),

  quality_rating smallint check (quality_rating between 1 and 5),
  timeliness_rating smallint check (timeliness_rating between 1 and 5),
  professionalism_rating smallint check (professionalism_rating between 1 and 5),
  communication_rating smallint check (communication_rating between 1 and 5),

  scope_as_agreed boolean,
  would_recommend boolean,
  would_use_smartlink_again boolean,
  comments text,

  -- The optional public review. When a customer opts in, a row is created in
  -- expert_reviews with review_status 'pending', so it goes through the
  -- moderation that already exists rather than appearing unreviewed.
  --
  -- Deliberately a link to a separate record, not a visibility flag on this
  -- one: a public review and a confidential survey are different things, and
  -- one row with a boolean would eventually be published by accident.
  public_review_opt_in boolean not null default false,
  expert_review_id uuid references expert_reviews(feedback_id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists idx_customer_surveys_expert
  on customer_satisfaction_surveys (expert_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Provider follow-up survey
-- ---------------------------------------------------------------------------
-- The provider's own account of whether an opportunity was worth having.
--
-- resulted_in_job is the important column: it is the provider's independent
-- answer to the question the platform also measures for itself from the jobs
-- table. Keeping both and comparing them is how the platform finds out whether
-- its own conversion figures are honest.
--
-- There is deliberately NO column for revenue, cost or profit. Providers were
-- promised they would not be asked to disclose profitability, and the way to
-- keep that promise is to have nowhere to put it.
create table if not exists provider_followup_surveys (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  -- One or the other, depending on whether the opportunity became a job.
  job_id uuid references jobs(id) on delete set null,
  introduction_request_id uuid references introduction_requests(id) on delete set null,

  resulted_in_job boolean not null,
  was_completed boolean,
  request_described_accurately boolean,
  customer_responsive boolean,
  opportunity_worthwhile boolean,
  would_accept_similar boolean,
  suggestions text,

  created_at timestamptz not null default now(),

  -- Must be about something.
  constraint provider_followup_has_subject check (
    job_id is not null or introduction_request_id is not null
  )
);

-- One survey per provider per subject. Partial indexes because either column
-- may be null, and Postgres treats NULLs as distinct -- a plain unique
-- constraint across both would allow unlimited duplicates.
create unique index if not exists idx_provider_followup_unique_job
  on provider_followup_surveys (expert_id, job_id)
  where job_id is not null;

create unique index if not exists idx_provider_followup_unique_introduction
  on provider_followup_surveys (expert_id, introduction_request_id)
  where introduction_request_id is not null;

create index if not exists idx_provider_followup_expert
  on provider_followup_surveys (expert_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Survey invitations
-- ---------------------------------------------------------------------------
-- Which providers have been asked, so the scheduler does not ask twice.
--
-- The customer side needs no equivalent: their survey rides on the completion
-- confirmation link, which already tracks its own delivery.
create table if not exists provider_survey_invitations (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  sent_at timestamptz not null default now(),

  constraint provider_survey_invitations_once unique (expert_id, job_id)
);

-- ---------------------------------------------------------------------------
-- Register the invitation task
-- ---------------------------------------------------------------------------
-- Daily. A follow-up survey is not urgent, and asking the morning after a job
-- closes reads as attentive where asking an hour after reads as automated.
insert into scheduled_tasks (task_key, interval_seconds) values
  ('provider_followup_surveys', 86400)
on conflict (task_key) do nothing;
