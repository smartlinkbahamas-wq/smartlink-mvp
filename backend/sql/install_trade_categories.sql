-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires the service_categories table (supabase_schema.sql).
--
-- WHY THIS EXISTS
-- The quiz had no trades at all. A customer typing "my shop needs an
-- electrician, the wiring is sparking" was matched to Technology/IT Support,
-- because the matching engine can only choose from categories that exist.
-- That was verified, not assumed: it is what the AI intake step actually
-- returned before these rows were added.
--
-- These are ordinary administrator-managed categories. They can be edited or
-- deactivated in Settings -> Categories without a deploy, and an inactive
-- parent takes its children with it.

-- ---------------------------------------------------------------------------
-- Parents
-- ---------------------------------------------------------------------------
-- risk_points drive lead priority. Electrical outranks the rest because a
-- fault is a safety matter before it is an inconvenience; a handyman job
-- rarely is.
insert into service_categories (slug, label, support_text, risk_points, segments, sort_order, is_active)
values
  ('need_electrical',
   'Electrical',
   'Wiring, outlets, breaker panels, lighting and electrical faults.',
   6, array['business-owner','personal-help','not-sure'], 90, true),

  ('need_plumbing',
   'Plumbing',
   'Leaks, blocked drains, water heaters and bathroom or kitchen fitting.',
   5, array['business-owner','personal-help','not-sure'], 100, true),

  ('need_air_conditioning',
   'Air conditioning and refrigeration',
   'Units not cooling, servicing, new installations and refrigeration.',
   4, array['business-owner','personal-help','not-sure'], 110, true),

  ('need_handyman',
   'Handyman and general repairs',
   'Carpentry, painting, doors and locks, assembly and general maintenance.',
   3, array['business-owner','personal-help','not-sure'], 120, true)
on conflict (slug) do update set
  label        = excluded.label,
  support_text = excluded.support_text,
  risk_points  = excluded.risk_points,
  segments     = excluded.segments,
  sort_order   = excluded.sort_order,
  is_active    = true,
  updated_at   = now();

-- ---------------------------------------------------------------------------
-- Subcategories
-- ---------------------------------------------------------------------------
-- A category with children makes the quiz ask which kind of work it is, which
-- is the difference between "an electrician" and "an electrician who does
-- panel upgrades". The parent is looked up by slug so this stays re-runnable
-- and never hardcodes a generated uuid.
insert into service_categories (parent_id, slug, label, support_text, risk_points, segments, sort_order, is_active)
select p.id, c.slug, c.label, c.support_text, c.risk_points, p.segments, c.sort_order, true
from (values
  -- Electrical
  ('need_electrical', 'need_electrical_fault',     'Fault finding or something not working', 'Power loss, tripping breakers or sparking.',        7, 10),
  ('need_electrical', 'need_electrical_wiring',    'Wiring or rewiring',                     'New circuits, rewiring or extending existing work.', 6, 20),
  ('need_electrical', 'need_electrical_panel',     'Breaker panel or meter',                 'Panel upgrades, breakers and metering.',             6, 30),
  ('need_electrical', 'need_electrical_fixtures',  'Outlets, switches or lighting',          'Fitting or replacing outlets, switches and lights.', 4, 40),
  ('need_electrical', 'need_electrical_generator', 'Generator or inverter',                  'Standby power, inverters and battery systems.',      5, 50),

  -- Plumbing
  ('need_plumbing',   'need_plumbing_leak',        'Leak or burst pipe',                     'Active leaks and water damage.',                     7, 10),
  ('need_plumbing',   'need_plumbing_blockage',    'Blocked drain or toilet',                'Slow or blocked drains, toilets and waste pipes.',   5, 20),
  ('need_plumbing',   'need_plumbing_water_heater','Water heater',                           'Repair or replacement of water heaters.',            4, 30),
  ('need_plumbing',   'need_plumbing_fitting',     'Bathroom or kitchen fitting',            'Installing sinks, showers, toilets and taps.',       4, 40),
  ('need_plumbing',   'need_plumbing_pump',        'Pump, cistern or water tank',            'Pumps, cisterns, tanks and supply problems.',        5, 50),

  -- Air conditioning
  ('need_air_conditioning', 'need_ac_not_cooling',  'Not cooling or not working',            'A unit running but not cooling, or not starting.',   5, 10),
  ('need_air_conditioning', 'need_ac_service',      'Servicing or cleaning',                 'Routine servicing, cleaning and filters.',           3, 20),
  ('need_air_conditioning', 'need_ac_install',      'New installation',                      'Supplying and fitting a new unit.',                  4, 30),
  ('need_air_conditioning', 'need_ac_refrigeration','Refrigeration or cold storage',         'Fridges, freezers and commercial cold storage.',     5, 40),

  -- Handyman
  ('need_handyman',   'need_handyman_carpentry',   'Carpentry or woodwork',                  'Repairs, shelving, decking and fitted woodwork.',    3, 10),
  ('need_handyman',   'need_handyman_painting',    'Painting or decorating',                 'Interior and exterior painting.',                    2, 20),
  ('need_handyman',   'need_handyman_doors',       'Doors, windows or locks',                'Hanging, adjusting, glazing and lock changes.',      4, 30),
  ('need_handyman',   'need_handyman_assembly',    'Assembly or mounting',                   'Flat-pack assembly, mounting and fixings.',          2, 40),
  ('need_handyman',   'need_handyman_maintenance', 'General maintenance',                    'Odd jobs and routine property upkeep.',              3, 50)
) as c(parent_slug, slug, label, support_text, risk_points, sort_order)
join service_categories p on p.slug = c.parent_slug
on conflict (slug) do update set
  parent_id    = excluded.parent_id,
  label        = excluded.label,
  support_text = excluded.support_text,
  risk_points  = excluded.risk_points,
  segments     = excluded.segments,
  sort_order   = excluded.sort_order,
  is_active    = true,
  updated_at   = now();
