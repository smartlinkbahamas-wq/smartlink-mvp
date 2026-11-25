-- Run this once in the Supabase SQL editor. Safe to re-run.
-- First piece of Priority 3. Requires nothing beyond the base schema.

-- ---------------------------------------------------------------------------
-- Customer records
-- ---------------------------------------------------------------------------
-- A provider's own customer list.
--
-- Created automatically when a provider accepts a SmartLink introduction, and
-- also usable for customers obtained elsewhere, so a provider can manage their
-- whole book here rather than keeping two lists.
--
-- Only name, email and telephone. No extended KYC: there is no legal or
-- business need for more, and collecting it would create an obligation to
-- protect it.
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  -- Email is the primary identifier, as specified, which is why the unique
  -- index below is on it rather than on the name. Two people called "J Smith"
  -- are two customers; one address reached twice is one customer.
  --
  -- Nullable because a provider may add a walk-in they only have a phone
  -- number for. Those rows simply do not participate in deduplication.
  email text,
  full_name text not null,
  phone text,

  -- 'smartlink' when the record was created by accepting an introduction,
  -- 'provider_entered' when the provider added it. Recorded at creation and
  -- never changed, for the same reason jobs.source is: it is what separates
  -- customers the platform produced from customers it merely stores.
  source text not null default 'provider_entered'
    check (source in ('smartlink', 'provider_entered')),

  -- The introduction that produced this record, where there was one.
  first_lead_id uuid references lead_submissions(id) on delete set null,
  first_introduction_request_id uuid references introduction_requests(id) on delete set null,

  notes text,
  -- Soft retirement, because a customer may be referenced by a quotation,
  -- invoice or job and deleting them would orphan that history.
  is_archived boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customers_full_name_not_blank check (length(btrim(full_name)) > 0)
);

-- One record per address per provider. Case-insensitive and trimmed, because
-- "J.Smith@x.com " and "j.smith@x.com" are the same person to everyone except
-- a naive unique index.
--
-- Scoped to the provider: two providers may both have the same customer, and
-- neither should see the other's record.
create unique index if not exists idx_customers_unique_email
  on customers (expert_id, lower(btrim(email)))
  where email is not null;

create index if not exists idx_customers_expert
  on customers (expert_id, full_name);
create index if not exists idx_customers_source
  on customers (source, created_at desc);

-- ---------------------------------------------------------------------------
-- Link existing documents to customers
-- ---------------------------------------------------------------------------
-- Added rather than required: quotations, invoices and jobs already carry the
-- customer's name and email directly, which is what the issued document must
-- show. This is the link back to the record, for "everything for this
-- customer" views -- not a replacement for those columns.
--
-- A document must never read its customer details through this foreign key: a
-- provider correcting a typo in a customer's name would otherwise silently
-- rewrite an invoice that has already been sent.
alter table quotations add column if not exists customer_id uuid references customers(id) on delete set null;
alter table invoices add column if not exists customer_id uuid references customers(id) on delete set null;
alter table jobs add column if not exists customer_id uuid references customers(id) on delete set null;

create index if not exists idx_quotations_customer on quotations (customer_id) where customer_id is not null;
create index if not exists idx_invoices_customer on invoices (customer_id) where customer_id is not null;
create index if not exists idx_jobs_customer on jobs (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Backfill from accepted introductions
-- ---------------------------------------------------------------------------
-- Providers who already accepted introductions before this existed should not
-- have to re-enter those customers by hand.
--
-- distinct on picks the earliest introduction per (provider, address), so the
-- record is attributed to the first time that customer appeared rather than
-- the most recent. Idempotent: the conflict clause leaves existing rows alone.
insert into customers (expert_id, email, full_name, phone, source, first_lead_id, first_introduction_request_id, created_at)
select distinct on (ir.expert_id, lower(btrim(ls.work_email)))
  ir.expert_id,
  ls.work_email,
  ls.full_name,
  ls.phone_number,
  'smartlink',
  ls.id,
  ir.id,
  ir.created_at
from introduction_requests ir
join lead_submissions ls on ls.id = ir.lead_id
where ir.status in ('accepted', 'connected', 'completed')
  and ls.work_email is not null
  and length(btrim(ls.work_email)) > 0
  and length(btrim(coalesce(ls.full_name, ''))) > 0
  and exists (select 1 from experts e where e.expert_id = ir.expert_id)
order by ir.expert_id, lower(btrim(ls.work_email)), ir.created_at asc
on conflict do nothing;
