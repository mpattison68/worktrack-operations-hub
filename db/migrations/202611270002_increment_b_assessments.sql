-- WorkTrack Increment B — Site Assessments, Benchmarks, Sizing, Budget & Immutable Scope Revisions
-- Portable PostgreSQL / self-hosted Supabase migration.

DO $$ BEGIN
  CREATE TYPE public.assessment_status AS ENUM ('draft', 'submitted', 'returned', 'approved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.distance_source AS ENUM ('gps_route', 'manual_chainage', 'manual_distance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.benchmark_confidence AS ENUM ('illustrative_assumption', 'estimated', 'verified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  productivity_sqm_per_worker_day numeric(10,2) NOT NULL CHECK (productivity_sqm_per_worker_day > 0),
  confidence public.benchmark_confidence NOT NULL DEFAULT 'illustrative_assumption',
  source_note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.benchmarks TO authenticated;
GRANT ALL ON public.benchmarks TO service_role;
ALTER TABLE public.benchmarks ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  job_id uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  customer_name text NOT NULL DEFAULT '',
  road_or_area text NOT NULL CHECK (length(trim(road_or_area)) > 0),
  direction_description text NOT NULL DEFAULT '',
  status public.assessment_status NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  start_gps jsonb,
  end_gps jsonb,
  gps_unavailable_reason text,
  distance_source public.distance_source NOT NULL DEFAULT 'manual_distance',
  original_distance_meters numeric(12,2) NOT NULL CHECK (original_distance_meters > 0),
  accepted_distance_meters numeric(12,2) NOT NULL CHECK (accepted_distance_meters > 0),
  distance_override_reason text,
  distance_provisional boolean NOT NULL DEFAULT false,
  sections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclusions text NOT NULL DEFAULT '',
  benchmark_id uuid,
  benchmark_productivity_sqm numeric(10,2) NOT NULL DEFAULT 250 CHECK (benchmark_productivity_sqm > 0),
  benchmark_confidence public.benchmark_confidence NOT NULL DEFAULT 'illustrative_assumption',
  productive_crew_size integer NOT NULL DEFAULT 12 CHECK (productive_crew_size > 0),
  road_worker_daily_rate_cents bigint NOT NULL DEFAULT 25000 CHECK (road_worker_daily_rate_cents >= 0),
  cook_weekly_rate_cents bigint NOT NULL DEFAULT 50000 CHECK (cook_weekly_rate_cents >= 0),
  include_cook boolean NOT NULL DEFAULT true,
  workdays_per_week smallint NOT NULL DEFAULT 5 CHECK (workdays_per_week BETWEEN 1 AND 7),
  contract_value_cents bigint NOT NULL DEFAULT 0 CHECK (contract_value_cents >= 0),
  budget_lines_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_comment text,
  revisions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id),
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, business_id) REFERENCES public.jobs(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (benchmark_id, business_id) REFERENCES public.benchmarks(id, business_id) ON DELETE RESTRICT,
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.assessments TO authenticated;
GRANT ALL ON public.assessments TO service_role;
ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.assessment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  snapshot jsonb NOT NULL,
  approved_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assessment_id, business_id) REFERENCES public.assessments(id, business_id) ON DELETE RESTRICT,
  UNIQUE (assessment_id, revision)
);
GRANT SELECT, INSERT ON public.assessment_revisions TO authenticated;
GRANT ALL ON public.assessment_revisions TO service_role;
ALTER TABLE public.assessment_revisions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "benchmarks_select_members" ON public.benchmarks
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "benchmarks_manage_admin" ON public.benchmarks
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY "assessments_select_members" ON public.assessments
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner','supervisor']::public.app_role[]));
CREATE POLICY "assessments_insert_members" ON public.assessments
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner','supervisor']::public.app_role[]));
CREATE POLICY "assessments_update_draft_or_admin" ON public.assessments
  FOR UPDATE TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin']::public.app_role[])
    OR (
      status IN ('draft', 'returned')
      AND public.has_business_role(business_id, ARRAY['owner','supervisor']::public.app_role[])
    )
  )
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin']::public.app_role[])
    OR (
      status IN ('draft', 'submitted')
      AND public.has_business_role(business_id, ARRAY['owner','supervisor']::public.app_role[])
    )
  );

CREATE POLICY "assessment_revisions_select_mgmt" ON public.assessment_revisions
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY "assessment_revisions_insert_admin" ON public.assessment_revisions
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));