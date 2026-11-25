-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Creates service_menu_items, the first piece of Priority 2.

-- A provider's list of services with prices.
--
-- Why this comes before quotations: not every trade quotes. A barber, a
-- stylist or a makeup artist works from a fixed price list and a diary, and
-- would never issue a formal quotation. Asking them to build one in order to
-- use the platform is the reason that group said a matching-only platform was
-- not worth paying for.
--
-- A `request_quote` item is the hand-off into the quotation flow, so this
-- table is also where custom-priced work starts.
create table if not exists service_menu_items (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  name text not null,
  description text,

  -- Fixed: the price is the price. Starting from: the price is a floor, the
  -- final figure comes from a quotation. Request quote: no price at all.
  pricing_mode text not null default 'fixed'
    check (pricing_mode in ('fixed', 'starting_from', 'request_quote')),

  price numeric(10, 2),
  currency text not null default 'USD',

  -- Feeds the calendar later. Null means "not stated", which is different
  -- from zero and must stay distinguishable.
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),

  -- Optional extras a provider lists against a service: [{label, amount}].
  -- Shape is enforced in the validator rather than here, because the list is
  -- provider-authored and a constraint would need a migration to extend.
  additional_charges jsonb not null default '[]'::jsonb,

  -- Whether a customer may book this service directly once customer-facing
  -- booking exists. Defaults to false: a provider opts in.
  bookable boolean not null default false,

  -- Soft hide. Deleting an item would orphan any quotation that referenced
  -- it, so a provider retires an item instead.
  is_active boolean not null default true,
  sort_order integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A "Fixed Price" item with no price is the single most likely way for this
  -- table to produce a menu that cannot be shown to a customer, so it is
  -- rejected at the database rather than trusted to the form.
  constraint service_menu_items_price_matches_mode check (
    (pricing_mode = 'request_quote' and price is null)
    or (pricing_mode in ('fixed', 'starting_from') and price is not null and price >= 0)
  ),

  -- Two services with the same name on one menu is a data-entry mistake, not
  -- a legitimate state, and it makes the list unreadable to a customer.
  constraint service_menu_items_name_not_blank check (length(btrim(name)) > 0)
);

-- The provider's own menu, in display order. Covers the only read this table
-- has: "everything for this provider".
create index if not exists idx_service_menu_items_expert
  on service_menu_items (expert_id, sort_order, created_at);

-- The customer-facing read skips retired items.
create index if not exists idx_service_menu_items_active
  on service_menu_items (expert_id, is_active)
  where is_active;

-- Case-insensitive, so "Haircut" and "haircut" collide as a customer would
-- read them. Scoped to active items: a retired name may be reused.
create unique index if not exists idx_service_menu_items_unique_name
  on service_menu_items (expert_id, lower(btrim(name)))
  where is_active;
