-- SYNTHETIC DEVELOPMENT / STAGING SEED ONLY.
-- DO NOT RUN IN PRODUCTION. Contains zero real worker, contract, or financial data.

INSERT INTO public.businesses (id, name, registration_number, default_vat_basis, timezone, currency)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Karoo Verge Clearing (Synthetic Dev)', 'SYN-2026/000101/07', 'not_registered', 'Africa/Johannesburg', 'ZAR'),
  ('22222222-2222-4222-8222-222222222222', 'Eastern Cape Roads Demo (Synthetic Tenant B)', 'SYN-2026/000202/07', 'exclusive', 'Africa/Johannesburg', 'ZAR')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.worker_roles (id, business_id, role_type, name, shares_crew_schedule)
VALUES
  ('41111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'road_worker', 'Road worker', true),
  ('42222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'cook', 'Camp cook', false),
  ('43333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'supervisor', 'Site supervisor', true),
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'driver', 'Truck driver', true)
ON CONFLICT (id) DO NOTHING;

-- Proposed illustrative rates ONLY (is_confirmed = false, no invented OT rates)
INSERT INTO public.pay_rules (
  id, business_id, worker_role_id, pay_basis, base_rate_cents,
  normal_hours_per_day, normal_workdays_per_week, weekly_proration_policy,
  effective_from, effective_to, is_confirmed, notes
) VALUES
  ('51111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '41111111-1111-4111-8111-111111111111', 'daily', 25000, 9, 5, 'none', '2026-11-01', NULL, false, 'Proposed initial daily rate only; Admin must confirm SA employment & OT rules.'),
  ('52222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '42222222-2222-4222-8222-222222222222', 'weekly', 50000, 8, 5, 'full_week_entitlement', '2026-11-01', NULL, false, 'Proposed initial weekly cook rate; Admin must confirm entitlement.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (
  id, business_id, name, customer_name, contract_reference,
  contract_value_cents, vat_basis, road_or_area, status,
  planned_start_date, planned_end_date, opening_cash_allocation_cents, work_requirements
) VALUES
  ('31111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Synthetic R63 Verge Clearing — Section North', 'Synthetic District Roads Agency', 'SYN-CTR-2026-01', 38000000, 'not_registered', 'R63 km 12.0 to km 22.0 (Synthetic)', 'active', '2026-11-02', '2026-12-18', 4500000, 'Grass cutting, bush clearing, litter removal (synthetic scope).'),
  ('39999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222', 'Tenant B Confidential Contract (Synthetic)', 'Other Agency', 'TENANT-B-01', 52000000, 'exclusive', 'N2 Bypass (Synthetic)', 'active', '2026-10-01', '2026-12-20', 6000000, 'Cross-tenant RLS verification job.')
ON CONFLICT (id) DO NOTHING;