-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_business_foundations.sql and install_quotations.sql.

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
-- Converted from an approved quotation with no re-entry.
--
-- There is no payment gateway and will not be one: payment stays between the
-- customer and the provider. This records what is owed and what has been
-- received; it does not move money.
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  invoice_number integer not null,
  reference text not null,

  -- The approved quotation this came from. Kept on delete so an invoice is
  -- never orphaned by tidying up quotations.
  quotation_id uuid references quotations(id) on delete set null,
  quotation_reference text,

  customer_name text not null,
  customer_email text not null,
  customer_phone text,

  job_name text not null,
  customer_summary text,
  terms text,

  line_items jsonb not null default '[]'::jsonb,

  discount_percent numeric(5, 2) not null default 0,
  discount_amount numeric(10, 2) not null default 0,
  discount_reason text,
  tax_rate_percent numeric(5, 2) not null default 0,
  tax_label text not null default 'Tax',
  additional_costs numeric(10, 2) not null default 0,
  additional_costs_label text not null default 'Shipping / additional costs',

  subtotal numeric(10, 2) not null default 0,
  discount_total numeric(10, 2) not null default 0,
  taxable_amount numeric(10, 2) not null default 0,
  tax_amount numeric(10, 2) not null default 0,
  total numeric(10, 2) not null default 0,
  currency text not null default 'USD',

  deposit_amount numeric(10, 2) not null default 0,
  payment_terms text,
  payment_instructions text,
  issue_date date not null default current_date,
  due_date date,

  -- The DOCUMENT's state only. Whether it is paid, part paid or overdue is
  -- derived from invoice_payments and due_date -- never stored here.
  --
  -- A status column cannot represent two part-payments, and an 'overdue' flag
  -- would be wrong between the due date passing and whatever job was meant to
  -- flip it running.
  status text not null default 'draft' check (status in ('draft', 'sent', 'cancelled')),

  business_identity jsonb,

  sent_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invoices_number_per_expert unique (expert_id, invoice_number),
  constraint invoices_job_name_not_blank check (length(btrim(job_name)) > 0),
  constraint invoices_amounts_not_negative check (
    subtotal >= 0 and discount_total >= 0 and taxable_amount >= 0
    and tax_amount >= 0 and additional_costs >= 0 and total >= 0
    and deposit_amount >= 0
  ),
  -- A deposit larger than the invoice is a data-entry error that would show
  -- the customer a negative balance.
  constraint invoices_deposit_within_total check (deposit_amount <= total)
);

create index if not exists idx_invoices_expert
  on invoices (expert_id, created_at desc);
create index if not exists idx_invoices_quotation
  on invoices (quotation_id)
  where quotation_id is not null;
create index if not exists idx_invoices_due
  on invoices (due_date)
  where status = 'sent';

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
-- One row per payment received.
--
-- This is the reason there is no paid/unpaid column on the invoice. A customer
-- who pays a deposit and then a balance has made two payments; a status field
-- can hold only the latest guess at what that means, while rows sum to a
-- figure that is simply correct.
create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  expert_id text not null references experts(expert_id) on delete cascade,

  amount numeric(10, 2) not null,
  paid_on date not null default current_date,
  -- Open text: cash, bank transfer, cheque and local wallets all occur, and a
  -- constraint here would need a migration for each new one.
  method text,
  reference text,
  notes text,
  recorded_by_user_id uuid,

  created_at timestamptz not null default now(),

  -- Zero is not a payment, and a negative row would be a refund -- which is a
  -- different thing with different reporting, and is not built.
  constraint invoice_payments_amount_positive check (amount > 0)
);

create index if not exists idx_invoice_payments_invoice
  on invoice_payments (invoice_id, paid_on);
create index if not exists idx_invoice_payments_expert
  on invoice_payments (expert_id, paid_on desc);
