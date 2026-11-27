-- WorkTrack Increment A — Foundation, Auth, RBAC, Jobs, Workforce & Audit Schema
-- Portable PostgreSQL / self-hosted Supabase migration.
-- All monetary amounts are integer ZAR cents (BIGINT). All timestamps are UTC.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'owner', 'supervisor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.job_status AS ENUM (
    'assessment_draft', 'submitted', 'returned', 'approved',
    'planned', 'active', 'work_complete', 'customer_accepted',
    'financially_closed', 'on_hold', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.vat_basis AS ENUM ('exclusive', 'inclusive', 'exempt', 'not_registered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.worker_role_type AS ENUM (
    'road_worker', 'supervisor', 'driver', 'cook', 'admin', 'owner', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pay_basis AS ENUM ('daily', 'hourly', 'weekly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.rate_change_status AS ENUM ('pending', 'approved', 'declined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.invitation_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Core tenant & identity tables
CREATE TABLE IF NOT EXISTS public.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  registration_number text,
  vat_number text,
  default_vat_basis public.vat_basis NOT NULL DEFAULT 'not_registered',
  timezone text NOT NULL DEFAULT 'Africa/Johannesburg',
  currency text NOT NULL DEFAULT 'ZAR',
  week_start_day smallint NOT NULL DEFAULT 1 CHECK (week_start_day = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  role public.app_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  assigned_job_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
GRANT SELECT, INSERT, UPDATE ON public.memberships TO authenticated;
GRANT ALL ON public.memberships TO service_role;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  email text NOT NULL,
  full_name text NOT NULL,
  role public.app_role NOT NULL,
  assigned_job_ids uuid[] NOT NULL DEFAULT '{}',
  status public.invitation_status NOT NULL DEFAULT 'pending',
  invited_by uuid REFERENCES auth.users(id),
  invited_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON public.invitations TO authenticated;
GRANT ALL ON public.invitations TO service_role;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- 3. Security-definer role helper functions (safe search_path, avoids RLS recursion)
CREATE OR REPLACE FUNCTION public.has_business_role(_business_id uuid, _roles public.app_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.business_id = _business_id
      AND m.user_id = auth.uid()
      AND m.active = true
      AND m.role = ANY(_roles)
  );
$$;
REVOKE ALL ON FUNCTION public.has_business_role(uuid, public.app_role[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_business_role(uuid, public.app_role[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_assigned_to_job(_business_id uuid, _job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.business_id = _business_id
      AND m.user_id = auth.uid()
      AND m.active = true
      AND (
        m.role IN ('admin', 'owner')
        OR _job_id = ANY(m.assigned_job_ids)
      )
  );
$$;
REVOKE ALL ON FUNCTION public.is_assigned_to_job(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_job(uuid, uuid) TO authenticated, service_role;

-- 4. Jobs & job revisions
CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  customer_name text NOT NULL CHECK (length(trim(customer_name)) > 0),
  contract_reference text NOT NULL DEFAULT '',
  contract_value_cents bigint NOT NULL DEFAULT 0 CHECK (contract_value_cents >= 0),
  vat_basis public.vat_basis NOT NULL DEFAULT 'not_registered',
  road_or_area text NOT NULL CHECK (length(trim(road_or_area)) > 0),
  status public.job_status NOT NULL DEFAULT 'planned',
  planned_start_date date,
  planned_end_date date,
  actual_start_date date,
  actual_end_date date,
  opening_cash_allocation_cents bigint NOT NULL DEFAULT 0 CHECK (opening_cash_allocation_cents >= 0),
  work_requirements text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end_date IS NULL OR planned_start_date IS NULL OR planned_end_date >= planned_start_date),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.jobs TO authenticated;
GRANT ALL ON public.jobs TO service_role;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.job_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  snapshot jsonb NOT NULL,
  reason text NOT NULL DEFAULT '',
  approved_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, business_id) REFERENCES public.jobs(id, business_id) ON DELETE RESTRICT,
  UNIQUE (job_id, revision)
);
GRANT SELECT, INSERT ON public.job_revisions TO authenticated;
GRANT ALL ON public.job_revisions TO service_role;
ALTER TABLE public.job_revisions ENABLE ROW LEVEL SECURITY;

-- 5. Worker roles, effective-dated pay rules, workers, overrides & assignments
CREATE TABLE IF NOT EXISTS public.worker_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  role_type public.worker_role_type NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  shares_crew_schedule boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.worker_roles TO authenticated;
GRANT ALL ON public.worker_roles TO service_role;
ALTER TABLE public.worker_roles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.pay_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  worker_role_id uuid NOT NULL,
  pay_basis public.pay_basis NOT NULL,
  base_rate_cents bigint NOT NULL CHECK (base_rate_cents > 0),
  normal_hours_per_day numeric(4,2) NOT NULL CHECK (normal_hours_per_day > 0 AND normal_hours_per_day <= 24),
  normal_workdays_per_week smallint NOT NULL CHECK (normal_workdays_per_week BETWEEN 1 AND 7),
  weekday_ot_hourly_cents bigint CHECK (weekday_ot_hourly_cents IS NULL OR weekday_ot_hourly_cents > 0),
  saturday_rate_cents bigint CHECK (saturday_rate_cents IS NULL OR saturday_rate_cents > 0),
  sunday_rate_cents bigint CHECK (sunday_rate_cents IS NULL OR sunday_rate_cents > 0),
  public_holiday_rate_cents bigint CHECK (public_holiday_rate_cents IS NULL OR public_holiday_rate_cents > 0),
  weekly_proration_policy text NOT NULL DEFAULT 'none'
    CHECK (weekly_proration_policy IN ('full_week_entitlement', 'prorated_by_days', 'none')),
  effective_from date NOT NULL,
  effective_to date,
  is_confirmed boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  FOREIGN KEY (worker_role_id, business_id) REFERENCES public.worker_roles(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT, UPDATE ON public.pay_rules TO authenticated;
GRANT ALL ON public.pay_rules TO service_role;
ALTER TABLE public.pay_rules ENABLE ROW LEVEL SECURITY;

-- Prevent overlapping effective date ranges per worker_role_id
CREATE OR REPLACE FUNCTION public.check_pay_rule_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pay_rules pr
    WHERE pr.worker_role_id = NEW.worker_role_id
      AND pr.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND (NEW.effective_to IS NULL OR NEW.effective_to >= pr.effective_from)
      AND (pr.effective_to IS NULL OR pr.effective_to >= NEW.effective_from)
  ) THEN
    RAISE EXCEPTION 'Overlapping effective dates for worker_role_id %', NEW.worker_role_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pay_rules_no_overlap ON public.pay_rules;
CREATE TRIGGER trg_pay_rules_no_overlap
  BEFORE INSERT OR UPDATE ON public.pay_rules
  FOR EACH ROW EXECUTE FUNCTION public.check_pay_rule_no_overlap();

CREATE TABLE IF NOT EXISTS public.workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  contact_phone text,
  worker_role_id uuid NOT NULL,
  employment_start_date date NOT NULL,
  employment_end_date date,
  active boolean NOT NULL DEFAULT true,
  opening_balance_cents bigint NOT NULL DEFAULT 0,
  opening_balance_source text NOT NULL DEFAULT '',
  opening_balance_verified boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (worker_role_id, business_id) REFERENCES public.worker_roles(id, business_id) ON DELETE RESTRICT,
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.workers TO authenticated;
GRANT ALL ON public.workers TO service_role;
ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.worker_rate_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL,
  pay_basis public.pay_basis NOT NULL,
  proposed_rate_cents bigint NOT NULL CHECK (proposed_rate_cents > 0),
  effective_from date NOT NULL,
  effective_to date,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  status public.rate_change_status NOT NULL DEFAULT 'pending',
  requested_by uuid REFERENCES auth.users(id),
  requested_by_email text,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (worker_id, business_id) REFERENCES public.workers(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT, UPDATE ON public.worker_rate_overrides TO authenticated;
GRANT ALL ON public.worker_rate_overrides TO service_role;
ALTER TABLE public.worker_rate_overrides ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.worker_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL,
  job_id uuid NOT NULL,
  assigned_from date NOT NULL,
  assigned_to date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (worker_id, business_id) REFERENCES public.workers(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, business_id) REFERENCES public.jobs(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT, UPDATE ON public.worker_assignments TO authenticated;
GRANT ALL ON public.worker_assignments TO service_role;
ALTER TABLE public.worker_assignments ENABLE ROW LEVEL SECURITY;

-- 6. Immutable audit log & idempotency receipts (designed from Increment A)
CREATE TABLE IF NOT EXISTS public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  actor_email text,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  reason text,
  changed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.audit_events TO authenticated;
GRANT ALL ON public.audit_events TO service_role;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  entity_type text NOT NULL,
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, idempotency_key)
);
GRANT SELECT, INSERT ON public.mutation_receipts TO authenticated;
GRANT ALL ON public.mutation_receipts TO service_role;
ALTER TABLE public.mutation_receipts ENABLE ROW LEVEL SECURITY;

-- 7. Row-Level Security Policies (strict tenant & role enforcement)
CREATE POLICY "businesses_select_admin_owner" ON public.businesses
  FOR SELECT TO authenticated
  USING (public.has_business_role(id, ARRAY['admin','owner']::public.app_role[]));

CREATE POLICY "businesses_update_admin_only" ON public.businesses
  FOR UPDATE TO authenticated
  USING (public.has_business_role(id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "profiles_own_select" ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "profiles_own_update" ON public.profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY "memberships_select_self_or_admin_owner" ON public.memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
  );
CREATE POLICY "memberships_manage_admin" ON public.memberships
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "invitations_select_admin_owner" ON public.invitations
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "invitations_manage_admin" ON public.invitations
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "jobs_select_assigned_or_mgmt" ON public.jobs
  FOR SELECT TO authenticated
  USING (public.is_assigned_to_job(business_id, id));
CREATE POLICY "jobs_manage_admin" ON public.jobs
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "job_revisions_select_mgmt" ON public.job_revisions
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "job_revisions_insert_admin" ON public.job_revisions
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "worker_roles_select_members" ON public.worker_roles
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner','supervisor']::public.app_role[]));
CREATE POLICY "worker_roles_manage_admin" ON public.worker_roles
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- Supervisors CANNOT view pay rules or rate overrides (T21)
CREATE POLICY "pay_rules_select_admin_owner" ON public.pay_rules
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "pay_rules_manage_admin" ON public.pay_rules
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "workers_select_scoped" ON public.workers
  FOR SELECT TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR EXISTS (
      SELECT 1 FROM public.worker_assignments wa
      WHERE wa.worker_id = workers.id
        AND wa.business_id = workers.business_id
        AND public.is_assigned_to_job(wa.business_id, wa.job_id)
    )
  );
CREATE POLICY "workers_insert_admin_owner" ON public.workers
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "workers_update_admin" ON public.workers
  FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "rate_overrides_select_admin_owner" ON public.worker_rate_overrides
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "rate_overrides_insert_admin_owner" ON public.worker_rate_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "rate_overrides_update_admin" ON public.worker_rate_overrides
  FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "assignments_select_scoped" ON public.worker_assignments
  FOR SELECT TO authenticated
  USING (public.is_assigned_to_job(business_id, job_id));
CREATE POLICY "assignments_manage_admin_owner" ON public.worker_assignments
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE POLICY "audit_select_admin" ON public.audit_events
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));
CREATE POLICY "audit_insert_members" ON public.audit_events
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_user_id = auth.uid()
    AND public.has_business_role(business_id, ARRAY['admin','owner','supervisor']::public.app_role[])
  );

CREATE POLICY "mutation_receipts_own_business" ON public.mutation_receipts
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner','supervisor']::public.app_role[]))
  WITH CHECK (
    actor_user_id = auth.uid()
    AND public.has_business_role(business_id, ARRAY['admin','owner','supervisor']::public.app_role[])
  );