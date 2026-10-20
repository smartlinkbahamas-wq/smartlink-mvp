-- Seeds the categories that were previously hardcoded in the quiz, plus the
-- "Application" category and its subcategories requested by the client.
-- Safe to re-run: every row is matched on its slug.

insert into service_categories (slug, label, support_text, risk_points, segments, sort_order)
values
  -- Business owner
  ('need_operations', 'Operations', 'Help with processes, execution, and bottlenecks.', 4, array['business-owner','not-sure'], 10),
  ('need_cybersecurity', 'Cybersecurity', 'Protection, backups, and recovery readiness.', 6, array['business-owner'], 20),
  ('need_systems', 'Systems', 'Support for tools, workflows, and business systems.', 4, array['business-owner'], 30),
  ('need_growth', 'Growth', 'Strategy, traction, and smarter next moves.', 3, array['business-owner'], 40),

  -- Personal help
  ('need_career_help', 'Career help', 'Direction, opportunities, and practical support.', 3, array['personal-help','not-sure'], 50),
  ('need_financial_advice', 'Financial advice', 'Planning, money decisions, and financial clarity.', 4, array['personal-help','not-sure'], 60),
  ('need_legal_help', 'Legal help', 'Personal legal guidance and support.', 5, array['personal-help','not-sure'], 70),
  ('need_personal_tech_support', 'Personal tech support', 'Device, account, and everyday technology help.', 4, array['personal-help','not-sure'], 80),
  ('need_application', 'Application', 'Visas, permits, licences, and official paperwork.', 5, array['personal-help'], 90),

  -- Shown only when the visitor is not sure what they need
  ('need_general_support', 'General support', 'Guided support when you are not sure where to begin.', 4, array['not-sure'], 100)
on conflict (slug) do update
  set label = excluded.label,
      support_text = excluded.support_text,
      risk_points = excluded.risk_points,
      segments = excluded.segments,
      sort_order = excluded.sort_order,
      updated_at = now();

-- Subcategories of Application. Segments are inherited from the parent, so the
-- segments column stays empty here.
insert into service_categories (parent_id, slug, label, support_text, risk_points, sort_order)
select
  parent.id,
  child.slug,
  child.label,
  child.support_text,
  child.risk_points,
  child.sort_order
from service_categories parent
cross join (
  values
    ('need_application_visa', 'Visa', 'Visa applications, renewals, and status questions.', 5, 10),
    ('need_application_immigration', 'Immigration', 'Residency, permits, and immigration status support.', 6, 20),
    ('need_application_business_licence', 'Business licence', 'Business licence applications and renewals.', 5, 30),
    ('need_application_passport', 'Passport', 'Passport applications, renewals, and replacements.', 4, 40)
) as child(slug, label, support_text, risk_points, sort_order)
where parent.slug = 'need_application'
on conflict (slug) do update
  set label = excluded.label,
      support_text = excluded.support_text,
      risk_points = excluded.risk_points,
      sort_order = excluded.sort_order,
      updated_at = now();
