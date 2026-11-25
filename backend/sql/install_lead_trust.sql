-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Creates the three tables behind Priority 1 "Core Marketplace and Lead Trust":
-- customer email verification, suspicious-lead reporting, and per-provider
-- notification preferences.

-- ---------------------------------------------------------------------------
-- 1. Customer email verification
-- ---------------------------------------------------------------------------
-- A customer proves they control the address before a service request is
-- written, so providers paying for leads are not paying for typos or invented
-- addresses. The code is stored hashed, never in plain text, so a leak of this
-- table does not let anyone verify an address they do not own.
create table if not exists customer_email_verifications (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  -- Kept for abuse investigation, not for identification.
  request_ip text,
  created_at timestamptz not null default now()
);

-- Lookups are always "the newest live challenge for this address".
create index if not exists idx_customer_email_verifications_email
  on customer_email_verifications (email, created_at desc);
create index if not exists idx_customer_email_verifications_expiry
  on customer_email_verifications (expires_at);

-- ---------------------------------------------------------------------------
-- 2. Suspicious lead reporting
-- ---------------------------------------------------------------------------
-- Providers pay to access opportunities, so they need a way to say "this one
-- is not genuine" and have someone look at it.
--
-- reason is open text with the vocabulary enforced in the validator rather
-- than a check constraint, because the list is meant to be adjusted without a
-- migration. Current values: fake_customer, payment_scam, repeated_abusive,
-- harassment, other.
create table if not exists suspicious_lead_reports (
  id uuid primary key default gen_random_uuid(),
  -- NOT NULL on purpose: a provider always reports a specific opportunity they
  -- were shown. It also makes the unique index below actually work, since
  -- Postgres treats NULLs as distinct and would otherwise allow duplicates.
  introduction_request_id uuid not null references introduction_requests(id) on delete cascade,
  lead_id uuid references lead_submissions(id) on delete set null,
  expert_id text not null references experts(expert_id) on delete cascade,
  reported_by_user_id uuid,
  reason text not null,
  notes text,
  status text not null default 'new' check (status in ('new','under_review','actioned','dismissed')),
  -- What an administrator decided, and why. Internal.
  review_outcome text,
  review_notes text,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One report per provider per opportunity: re-reporting updates rather than
-- stacking duplicates in the admin queue.
create unique index if not exists idx_suspicious_lead_reports_unique
  on suspicious_lead_reports (expert_id, introduction_request_id);
create index if not exists idx_suspicious_lead_reports_status
  on suspicious_lead_reports (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Notification preferences
-- ---------------------------------------------------------------------------
-- Lead alerts are the provider's choice: immediate, one daily summary, or off.
--
-- Operational notices — complaints, disputes, administrator decisions — are
-- deliberately NOT represented here. They are always on, and leaving them out
-- of the table is what makes that structural rather than a default somebody
-- can flip later.
create table if not exists notification_preferences (
  expert_id text primary key references experts(expert_id) on delete cascade,
  lead_alerts text not null default 'immediate'
    check (lead_alerts in ('immediate','daily_summary','off')),
  -- When the last daily summary went out, so the scheduler does not send two
  -- in one day or replay the window after a restart.
  daily_summary_last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notification_preferences_lead_alerts
  on notification_preferences (lead_alerts);

-- Every existing provider gets the default explicitly, so the daily-summary
-- job can read this table alone rather than joining to experts to discover
-- who has no row. Idempotent.
insert into notification_preferences (expert_id)
select e.expert_id
from experts e
where not exists (
  select 1 from notification_preferences p where p.expert_id = e.expert_id
);
