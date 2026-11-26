-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_jobs.sql and install_customers.sql.

-- ---------------------------------------------------------------------------
-- Support tickets
-- ---------------------------------------------------------------------------
-- Two categories, as specified: platform support, and job-related complaints.
--
-- This is NOT a helpdesk. There are no queues, no SLAs, no canned replies, no
-- routing rules and no agent load balancing. That boundary was set
-- deliberately and holds: the thing being built is a record of a conversation,
-- not a contact centre.
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),

  -- Human-readable, for quoting in an email or over the telephone.
  reference text not null unique,

  category text not null check (category in ('platform_support', 'job_complaint')),

  -- Who raised it. A customer has no account, so they are identified by the
  -- address the ticket came from rather than by a user id.
  raised_by text not null check (raised_by in ('customer', 'provider', 'administrator')),
  raised_by_user_id uuid,
  raised_by_email text,
  raised_by_name text,

  -- What it is about. All nullable: a platform support ticket may concern
  -- nothing in particular.
  job_id uuid references jobs(id) on delete set null,
  expert_id text references experts(expert_id) on delete set null,
  customer_id uuid references customers(id) on delete set null,

  subject text not null,
  -- The original text, exactly as written.
  --
  -- For a complaint this is NEVER shown to the provider. They receive the
  -- administrator's summary below. Sharing the original is a separate,
  -- deliberate act -- see original_shared_at.
  body text not null,

  status text not null default 'new' check (status in (
    'new',
    'under_review',
    'awaiting_customer',
    'awaiting_provider',
    'resolved',
    'closed'
  )),

  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),

  assigned_to_user_id uuid,

  -- The complaint visibility rule, in columns.
  --
  -- provider_summary is what the provider sees: an account prepared by an
  -- administrator, not the customer's words. The provider may ask for the
  -- original, and an administrator may then share it -- recorded here so the
  -- decision and its timing are evidenced rather than remembered.
  provider_summary text,
  provider_summary_at timestamptz,
  original_requested_at timestamptz,
  original_shared_at timestamptz,
  original_share_decided_by uuid,

  resolution text,
  resolved_at timestamptz,
  closed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_tickets_subject_not_blank check (length(btrim(subject)) > 0),
  constraint support_tickets_body_not_blank check (length(btrim(body)) > 0),

  -- A resolved or closed ticket has to say how it was resolved. "Resolved,
  -- reason unknown" cannot be reported on and cannot be learned from.
  constraint support_tickets_resolution_recorded check (
    status not in ('resolved', 'closed') or resolution is not null
  ),

  -- The original can only have been shared if it was asked for. Without this
  -- a share could be recorded with no request behind it, which is exactly the
  -- sequence the rule exists to govern.
  constraint support_tickets_share_follows_request check (
    original_shared_at is null or original_requested_at is not null
  )
);

create index if not exists idx_support_tickets_status
  on support_tickets (status, created_at desc);
create index if not exists idx_support_tickets_expert
  on support_tickets (expert_id, created_at desc)
  where expert_id is not null;
create index if not exists idx_support_tickets_job
  on support_tickets (job_id)
  where job_id is not null;
create index if not exists idx_support_tickets_open
  on support_tickets (created_at desc)
  where status not in ('resolved', 'closed');

-- ---------------------------------------------------------------------------
-- Ticket messages
-- ---------------------------------------------------------------------------
-- The conversation.
--
-- visible_to is the control that makes complaint handling work. An
-- administrator's working notes are 'internal' and are never returned by any
-- endpoint a provider or customer can reach -- not hidden on screen, but
-- filtered in the query, so a mistake in the interface cannot leak them.
create table if not exists support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,

  author_type text not null check (author_type in ('customer', 'provider', 'administrator', 'system')),
  author_user_id uuid,
  author_name text,

  body text not null,

  -- 'internal'  — administrators only, forever.
  -- 'provider'  — the administrator and the provider.
  -- 'customer'  — the administrator and the customer.
  -- 'all'       — everyone on the ticket.
  visible_to text not null default 'internal'
    check (visible_to in ('internal', 'provider', 'customer', 'all')),

  created_at timestamptz not null default now(),

  constraint support_ticket_messages_body_not_blank check (length(btrim(body)) > 0)
);

create index if not exists idx_support_ticket_messages_ticket
  on support_ticket_messages (ticket_id, created_at);

-- Reading a provider's or customer's view of a thread is the hot path, and it
-- always excludes internal notes.
create index if not exists idx_support_ticket_messages_shared
  on support_ticket_messages (ticket_id, created_at)
  where visible_to <> 'internal';

-- ---------------------------------------------------------------------------
-- Ticket numbering
-- ---------------------------------------------------------------------------
-- Platform-wide rather than per provider: a ticket reference is quoted between
-- an administrator and whoever raised it, and two people holding "TKT-0007"
-- would be a genuine problem.
create table if not exists support_ticket_counter (
  id boolean primary key default true check (id),
  next_number integer not null default 1,
  updated_at timestamptz not null default now()
);

insert into support_ticket_counter (id) values (true) on conflict (id) do nothing;

create or replace function next_support_ticket_number()
returns integer
language plpgsql
as $$
declare
  v_number integer;
begin
  -- Row-locked for the transaction, so two tickets raised at the same instant
  -- cannot receive the same reference.
  update support_ticket_counter
  set next_number = next_number + 1,
      updated_at = now()
  where id = true
  returning next_number - 1 into v_number;

  return v_number;
end;
$$;
