-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_business_foundations.sql.

-- ---------------------------------------------------------------------------
-- The provider's own hourly COST
-- ---------------------------------------------------------------------------
-- experts.hourly_rate_usd already exists, and it is a SELL rate: the matching
-- engine compares it against the customer's budget. Using it as a labour cost
-- would price every job at cost and report zero profit on all of them.
--
-- This is the separate figure -- what an hour of work costs the business.
-- It is never shown to a customer and never reaches the matching engine.
alter table experts add column if not exists hourly_cost_usd numeric(10, 2);

-- ---------------------------------------------------------------------------
-- Cost estimates
-- ---------------------------------------------------------------------------
-- What a job costs the provider, and what it should therefore be sold for.
--
-- Nothing here is ever shown to a customer. The only values that cross into a
-- quotation are job_name, customer_summary and final_price, handed over by a
-- single mapper so there is exactly one place where that boundary is crossed
-- and one place to check it.
create table if not exists quickcost_estimates (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  job_name text not null,
  -- The customer-safe description. Deliberately separate from any internal
  -- note, so a provider's private remarks about a job cannot be carried into
  -- a quotation by accident.
  customer_summary text,
  internal_notes text,

  -- [{ kind, label, quantity, unitCost }] where kind is one of material,
  -- labour, subcontractor, transport, equipment, other.
  --
  -- One array rather than one per category: every kind is the same arithmetic
  -- (quantity x unit cost), and labour is simply hours x hourly cost. A column
  -- per category would mean six code paths that must agree about rounding.
  cost_items jsonb not null default '[]'::jsonb,

  -- A flat business overhead for the job, not tied to any line.
  overhead_amount numeric(10, 2) not null default 0,

  target_margin_percent numeric(5, 2) not null default 0,

  -- Recomputed by the server on every write. Stored as columns rather than
  -- inside the jsonb so they can be summed and reported on; the request body
  -- never supplies them, so a client cannot forge a profit figure.
  items_cost numeric(10, 2) not null default 0,
  total_cost numeric(10, 2) not null default 0,
  suggested_price numeric(10, 2) not null default 0,
  -- What the provider decided to charge. May be below cost, deliberately.
  final_price numeric(10, 2) not null default 0,
  profit numeric(10, 2) not null default 0,
  margin_percent numeric(7, 2) not null default 0,
  markup_percent numeric(9, 2) not null default 0,

  -- Filled in after the work is done, for estimate-versus-actual reporting.
  -- The columns ship now so the comparison has history to draw on when the
  -- reporting screen is built; nothing writes them yet.
  actual_cost numeric(10, 2),
  actual_revenue numeric(10, 2),
  actual_recorded_at timestamptz,

  currency text not null default 'USD',
  status text not null default 'draft' check (status in ('draft', 'quoted', 'won', 'lost', 'archived')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint quickcost_job_name_not_blank check (length(btrim(job_name)) > 0),
  -- A margin of 100% divides by zero when deriving a price. Capped here as
  -- well as in the money module.
  constraint quickcost_margin_range check (target_margin_percent >= 0 and target_margin_percent <= 99),
  constraint quickcost_costs_not_negative check (overhead_amount >= 0 and items_cost >= 0 and total_cost >= 0)
);

create index if not exists idx_quickcost_estimates_expert
  on quickcost_estimates (expert_id, created_at desc);
create index if not exists idx_quickcost_estimates_status
  on quickcost_estimates (expert_id, status);
