-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_business_foundations.sql.

-- ---------------------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------------------
-- The calculation order is fixed and was specified exactly:
--
--   Subtotal -> Discount (%) -> Tax Rate (%) -> Shipping/Additional -> Total
--
-- Discount comes off before tax. Additional costs fall after tax and are
-- therefore not taxed. All of it is computed in src/utils/money.js and written
-- here; the client never sends a total.
create table if not exists quotations (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  -- Per provider and gap-free, from next_document_number(). reference is the
  -- display form and is stored rather than derived, so a change to the format
  -- never alters what a customer was already sent.
  quotation_number integer not null,
  reference text not null,

  -- Where the work came from. Nullable because a provider may quote a
  -- customer who never came through the platform.
  lead_id uuid references lead_submissions(id) on delete set null,
  introduction_request_id uuid references introduction_requests(id) on delete set null,
  source_estimate_id uuid,

  customer_name text not null,
  customer_email text not null,
  customer_phone text,

  job_name text not null,
  customer_summary text,
  terms text,

  -- [{ label, description, quantity, unitPrice, lineTotal, informational }]
  --
  -- informational items carry no price and are excluded from the arithmetic:
  -- a florist records the event date, the flower colours or a special
  -- instruction without it touching the total.
  line_items jsonb not null default '[]'::jsonb,

  discount_percent numeric(5, 2) not null default 0,
  discount_amount numeric(10, 2) not null default 0,
  discount_reason text,

  -- Default 0%, as specified. tax_label lets a provider print "VAT" or "GST".
  tax_rate_percent numeric(5, 2) not null default 0,
  tax_label text not null default 'Tax',

  additional_costs numeric(10, 2) not null default 0,
  additional_costs_label text not null default 'Shipping / additional costs',

  -- All server-computed.
  subtotal numeric(10, 2) not null default 0,
  discount_total numeric(10, 2) not null default 0,
  taxable_amount numeric(10, 2) not null default 0,
  tax_amount numeric(10, 2) not null default 0,
  total numeric(10, 2) not null default 0,
  currency text not null default 'USD',

  -- Default 30 days, no mandatory minimum: a provider may choose 24 hours.
  validity_days integer not null default 30,
  valid_until timestamptz,

  status text not null default 'draft' check (status in (
    'draft', 'sent', 'approved', 'declined', 'changes_requested', 'superseded'
  )),

  -- Not a stored 'expired' status. Expiry is a function of valid_until and the
  -- current time; storing it would need a scheduled job to stay true and would
  -- be wrong for the window between expiry and that job running.

  version integer not null default 1,
  supersedes_id uuid references quotations(id) on delete set null,

  -- A snapshot of who issued it, taken when the quotation is sent.
  --
  -- Not read live from experts: a provider who later changes their address or
  -- deregisters for VAT must not retroactively alter a document a customer has
  -- already approved. This is the issued record.
  business_identity jsonb,

  sent_at timestamptz,
  approved_at timestamptz,
  -- How the customer proved who they were: 'email_code' today.
  approval_method text,
  approved_terms boolean,
  responded_at timestamptz,
  customer_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint quotations_number_per_expert unique (expert_id, quotation_number),
  constraint quotations_job_name_not_blank check (length(btrim(job_name)) > 0),
  constraint quotations_discount_percent_range check (discount_percent >= 0 and discount_percent <= 100),
  constraint quotations_tax_rate_range check (tax_rate_percent >= 0 and tax_rate_percent <= 100),
  constraint quotations_validity_positive check (validity_days > 0),
  constraint quotations_amounts_not_negative check (
    subtotal >= 0 and discount_total >= 0 and taxable_amount >= 0
    and tax_amount >= 0 and additional_costs >= 0 and total >= 0
  ),
  -- An approved quotation must record how the customer was identified.
  -- Without this an approval could exist with no evidence behind it.
  constraint quotations_approval_has_method check (
    status <> 'approved' or (approved_at is not null and approval_method is not null)
  )
);

create index if not exists idx_quotations_expert
  on quotations (expert_id, created_at desc);
create index if not exists idx_quotations_status
  on quotations (expert_id, status);
create index if not exists idx_quotations_customer_email
  on quotations (lower(customer_email));
create index if not exists idx_quotations_lead
  on quotations (lead_id)
  where lead_id is not null;

-- ---------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------
-- An immutable snapshot each time a quotation is sent.
--
-- Required by the locking rule: once a customer approves, the price and terms
-- are fixed, and a change means a new quotation. To prove what was approved,
-- the exact document has to survive any later editing.
create table if not exists quotation_versions (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references quotations(id) on delete cascade,
  version integer not null,
  -- The whole row as it stood. Deliberately denormalised: this is a record of
  -- what was sent, not a view that follows later changes.
  snapshot jsonb not null,
  created_at timestamptz not null default now(),

  constraint quotation_versions_unique unique (quotation_id, version)
);

create index if not exists idx_quotation_versions_quotation
  on quotation_versions (quotation_id, version desc);

-- ---------------------------------------------------------------------------
-- Saved line items
-- ---------------------------------------------------------------------------
-- Services and charges a provider uses often, so they are not retyped on
-- every quotation.
create table if not exists saved_line_items (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,
  label text not null,
  description text,
  unit_price numeric(10, 2) not null default 0,
  unit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint saved_line_items_label_not_blank check (length(btrim(label)) > 0)
);

create index if not exists idx_saved_line_items_expert
  on saved_line_items (expert_id, label);

-- ---------------------------------------------------------------------------
-- Quotation templates
-- ---------------------------------------------------------------------------
-- A complete reusable quotation: a caterer's 50-person package, a makeup
-- artist's bridal package.
create table if not exists quotation_templates (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,
  name text not null,
  description text,
  -- The same shape a quotation holds, minus the customer.
  template jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint quotation_templates_name_not_blank check (length(btrim(name)) > 0),
  constraint quotation_templates_unique_name unique (expert_id, name)
);

create index if not exists idx_quotation_templates_expert
  on quotation_templates (expert_id, name);

-- ---------------------------------------------------------------------------
-- Suggested charges by business category
-- ---------------------------------------------------------------------------
-- Optional prompts when building a quotation. The provider always controls
-- their own prices; these are labels, never amounts.
--
-- Administrator-editable rows rather than a hardcoded list, because a wrong
-- list is worse than none and curating one is cheaper than shipping code.
-- Seeded with three categories deliberately, not six: more can be added
-- through this table without a migration.
create table if not exists suggested_charges (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  label text not null,
  -- 'chargeable' items become priced lines; 'informational' ones are recorded
  -- on the quotation without affecting the total.
  charge_type text not null default 'chargeable'
    check (charge_type in ('chargeable', 'informational')),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint suggested_charges_unique unique (category, label)
);

create index if not exists idx_suggested_charges_category
  on suggested_charges (category, sort_order)
  where is_active;

insert into suggested_charges (category, label, charge_type, sort_order) values
  ('Florist', 'Number of stems',        'chargeable',    1),
  ('Florist', 'Flower type',            'informational', 2),
  ('Florist', 'Arrangement labour',     'chargeable',    3),
  ('Florist', 'Wrapping',               'chargeable',    4),
  ('Florist', 'Vase',                   'chargeable',    5),
  ('Florist', 'Delivery',               'chargeable',    6),
  ('Florist', 'Setup',                  'chargeable',    7),
  ('Florist', 'Event date',             'informational', 8),
  ('Florist', 'Preferred colours',      'informational', 9),
  ('Florist', 'Special instructions',   'informational', 10),

  ('Caterer', 'Number of meals',        'chargeable',    1),
  ('Caterer', 'Price per person',       'chargeable',    2),
  ('Caterer', 'Food package',           'chargeable',    3),
  ('Caterer', 'Drinks',                 'chargeable',    4),
  ('Caterer', 'Delivery',               'chargeable',    5),
  ('Caterer', 'Staffing',               'chargeable',    6),
  ('Caterer', 'Setup',                  'chargeable',    7),
  ('Caterer', 'Dietary requirements',   'informational', 8),
  ('Caterer', 'Event date',             'informational', 9),

  ('Electrician / Handyman', 'Labour',            'chargeable',    1),
  ('Electrician / Handyman', 'Materials',         'chargeable',    2),
  ('Electrician / Handyman', 'Call-out fee',      'chargeable',    3),
  ('Electrician / Handyman', 'Travel',            'chargeable',    4),
  ('Electrician / Handyman', 'Equipment rental',  'chargeable',    5),
  ('Electrician / Handyman', 'Emergency service', 'chargeable',    6),
  ('Electrician / Handyman', 'Site access notes', 'informational', 7)
on conflict (category, label) do nothing;
