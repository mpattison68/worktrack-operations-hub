-- WorkTrack — Increment C: Daily Progress, Interruptions, Weekly Attendance & Payroll
-- Portable PostgreSQL + Supabase RLS migration (customer-owned, self-hosted VM ready)

-- ============================================================================
-- 1. Progress entries (chainage ranges per strip & required activity)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.progress_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  section_id text NOT NULL,
  verge_side text NOT NULL CHECK (verge_side IN ('left','right','outer_a','inner_a','inner_b','outer_b','shared_median')),
  activity text NOT NULL CHECK (activity IN ('cutting','manual_clearing','waste_collection','finishing','other')),
  reported_date date NOT NULL,
  start_chainage_meters numeric(12,2) NOT NULL CHECK (start_chainage_meters >= 0),
  end_chainage_meters numeric(12,2) NOT NULL CHECK (end_chainage_meters > start_chainage_meters),
  stage_status text NOT NULL CHECK (stage_status IN ('in_progress','partial','complete')),
  is_rework boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','gps_snapped')),
  gps_accuracy_meters numeric(8,2) CHECK (gps_accuracy_meters IS NULL OR gps_accuracy_meters >= 0),
  photo_date date,
  evidence_note text NOT NULL DEFAULT '',
  verification_state text NOT NULL DEFAULT 'reported' CHECK (verification_state IN ('reported','verified','flagged_conflict')),
  conflict_reason text,
  submitted_by_email text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.progress_entries TO authenticated;
GRANT ALL ON public.progress_entries TO service_role;

ALTER TABLE public.progress_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY progress_entries_select ON public.progress_entries
  FOR SELECT TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

CREATE POLICY progress_entries_insert ON public.progress_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

CREATE POLICY progress_entries_update ON public.progress_entries
  FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE INDEX IF NOT EXISTS idx_progress_entries_job_date
  ON public.progress_entries(business_id, job_id, reported_date);

-- ============================================================================
-- 2. Interruptions log
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.interruptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  interruption_date date NOT NULL,
  duration_hours numeric(5,2) NOT NULL CHECK (duration_hours >= 0 AND duration_hours <= 24),
  full_day boolean NOT NULL DEFAULT false,
  affected_crew_or_section text NOT NULL DEFAULT '',
  reason text NOT NULL CHECK (reason IN ('rain','vehicle','equipment','fuel','customer','public_holiday','other')),
  comment text NOT NULL DEFAULT '',
  submitted_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.interruptions TO authenticated;
GRANT ALL ON public.interruptions TO service_role;

ALTER TABLE public.interruptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY interruptions_select ON public.interruptions
  FOR SELECT TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

CREATE POLICY interruptions_insert ON public.interruptions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

CREATE INDEX IF NOT EXISTS idx_interruptions_job_date
  ON public.interruptions(business_id, job_id, interruption_date);

-- ============================================================================
-- 3. Team days (unique per job/date)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.team_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  work_date date NOT NULL,
  day_status text NOT NULL DEFAULT 'unknown' CHECK (day_status IN ('unknown','worked','partial','no_work')),
  normal_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (normal_hours >= 0 AND normal_hours <= 24),
  weekday_ot_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (weekday_ot_hours >= 0 AND weekday_ot_hours <= 24),
  saturday_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (saturday_hours >= 0 AND saturday_hours <= 24),
  sunday_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (sunday_hours >= 0 AND sunday_hours <= 24),
  public_holiday_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (public_holiday_hours >= 0 AND public_holiday_hours <= 24),
  interruption_reason text CHECK (interruption_reason IS NULL OR interruption_reason IN ('rain','vehicle','equipment','fuel','customer','public_holiday','other')),
  notes text NOT NULL DEFAULT '',
  updated_by_email text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_days_total_hours_le_24 CHECK (
    normal_hours + weekday_ot_hours + saturday_hours + sunday_hours + public_holiday_hours <= 24
  ),
  CONSTRAINT team_days_unique_job_date UNIQUE (business_id, job_id, work_date)
);

GRANT SELECT, INSERT, UPDATE ON public.team_days TO authenticated;
GRANT ALL ON public.team_days TO service_role;

ALTER TABLE public.team_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_days_select ON public.team_days
  FOR SELECT TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

CREATE POLICY team_days_write ON public.team_days
  FOR ALL TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  )
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

-- ============================================================================
-- 4. Worker attendance entries (unique per worker/job/date; preserves overrides)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.attendance_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  worker_id uuid NOT NULL REFERENCES public.workers(id),
  work_date date NOT NULL,
  day_status text NOT NULL DEFAULT 'unknown' CHECK (day_status IN ('unknown','worked','partial','no_work')),
  normal_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (normal_hours >= 0 AND normal_hours <= 24),
  weekday_ot_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (weekday_ot_hours >= 0 AND weekday_ot_hours <= 24),
  saturday_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (saturday_hours >= 0 AND saturday_hours <= 24),
  sunday_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (sunday_hours >= 0 AND sunday_hours <= 24),
  public_holiday_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (public_holiday_hours >= 0 AND public_holiday_hours <= 24),
  is_override boolean NOT NULL DEFAULT true,
  override_reason text,
  updated_by_email text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_total_hours_le_24 CHECK (
    normal_hours + weekday_ot_hours + saturday_hours + sunday_hours + public_holiday_hours <= 24
  ),
  CONSTRAINT attendance_unique_worker_job_date UNIQUE (business_id, worker_id, job_id, work_date)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_entries TO authenticated;
GRANT ALL ON public.attendance_entries TO service_role;

ALTER TABLE public.attendance_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY attendance_entries_select ON public.attendance_entries
  FOR SELECT TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

CREATE POLICY attendance_entries_write ON public.attendance_entries
  FOR ALL TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  )
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR public.is_assigned_to_job(business_id, job_id)
  );

-- ============================================================================
-- 5. Payroll runs (admin/owner read; admin approve; supervisors DENIED — T21)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  week_start_date date NOT NULL,
  week_end_date date NOT NULL CHECK (week_end_date = week_start_date + 6),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  gross_total_cents bigint NOT NULL DEFAULT 0 CHECK (gross_total_cents >= 0),
  adjustments_total_cents bigint NOT NULL DEFAULT 0,
  deductions_total_cents bigint NOT NULL DEFAULT 0 CHECK (deductions_total_cents >= 0),
  net_total_cents bigint NOT NULL DEFAULT 0,
  approved_by_email text,
  approved_at timestamptz,
  correction_reason text,
  supersedes_run_id uuid REFERENCES public.payroll_runs(id),
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_runs_unique_rev UNIQUE (business_id, job_id, week_start_date, revision)
);

GRANT SELECT, INSERT, UPDATE ON public.payroll_runs TO authenticated;
GRANT ALL ON public.payroll_runs TO service_role;

ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_runs_select_admin_owner ON public.payroll_runs
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE POLICY payroll_runs_write_admin ON public.payroll_runs
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- Only one approved revision per business/job/week at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_single_approved
  ON public.payroll_runs(business_id, job_id, week_start_date)
  WHERE status = 'approved';

-- Prevent mutating approved payroll totals/dates; only allow transitioning status to 'superseded'
CREATE OR REPLACE FUNCTION public.guard_approved_payroll_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.status = 'superseded'
       AND NEW.gross_total_cents = OLD.gross_total_cents
       AND NEW.net_total_cents = OLD.net_total_cents
       AND NEW.week_start_date = OLD.week_start_date THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Approved payroll runs are immutable; create a new correction revision instead.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_approved_payroll_immutability ON public.payroll_runs;
CREATE TRIGGER trg_guard_approved_payroll_immutability
  BEFORE UPDATE OR DELETE ON public.payroll_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_approved_payroll_immutability();

-- ============================================================================
-- 6. Payroll earnings lines (pay-rule snapshot preserved; no CASCADE delete)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payroll_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  payroll_run_id uuid NOT NULL REFERENCES public.payroll_runs(id),
  worker_id uuid NOT NULL REFERENCES public.workers(id),
  days_worked numeric(5,2) NOT NULL DEFAULT 0,
  normal_hours numeric(6,2) NOT NULL DEFAULT 0,
  weekday_ot_hours numeric(6,2) NOT NULL DEFAULT 0,
  saturday_hours numeric(6,2) NOT NULL DEFAULT 0,
  sunday_hours numeric(6,2) NOT NULL DEFAULT 0,
  public_holiday_hours numeric(6,2) NOT NULL DEFAULT 0,
  normal_pay_cents bigint NOT NULL DEFAULT 0,
  weekday_ot_pay_cents bigint NOT NULL DEFAULT 0,
  saturday_pay_cents bigint NOT NULL DEFAULT 0,
  sunday_pay_cents bigint NOT NULL DEFAULT 0,
  public_holiday_pay_cents bigint NOT NULL DEFAULT 0,
  gross_pay_cents bigint NOT NULL DEFAULT 0,
  adjustments_cents bigint NOT NULL DEFAULT 0,
  deductions_cents bigint NOT NULL DEFAULT 0,
  net_pay_cents bigint NOT NULL DEFAULT 0,
  rule_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_earnings_unique_run_worker UNIQUE (payroll_run_id, worker_id)
);

GRANT SELECT, INSERT, UPDATE ON public.payroll_earnings TO authenticated;
GRANT ALL ON public.payroll_earnings TO service_role;

ALTER TABLE public.payroll_earnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_earnings_select_admin_owner ON public.payroll_earnings
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE POLICY payroll_earnings_write_admin ON public.payroll_earnings
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- ============================================================================
-- 7. Payroll adjustments & statutory deductions
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  payroll_run_id uuid NOT NULL REFERENCES public.payroll_runs(id),
  worker_id uuid NOT NULL REFERENCES public.workers(id),
  kind text NOT NULL CHECK (kind IN ('allowance','bonus','statutory_deduction','correction')),
  description text NOT NULL,
  amount_cents bigint NOT NULL,
  approved_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.payroll_adjustments TO authenticated;
GRANT ALL ON public.payroll_adjustments TO service_role;

ALTER TABLE public.payroll_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_adjustments_select_admin_owner ON public.payroll_adjustments
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE POLICY payroll_adjustments_write_admin ON public.payroll_adjustments
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- ============================================================================
-- 8. Transactional server-side payroll approval RPC (Admin-only, safe search_path)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_payroll_run(
  _run_id uuid,
  _actor_email text
)
RETURNS public.payroll_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = _run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run not found.';
  END IF;

  IF NOT public.has_business_role(v_run.business_id, ARRAY['admin']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only Management / Admin can approve payroll runs.';
  END IF;

  IF v_run.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft payroll runs can be approved.';
  END IF;

  UPDATE public.payroll_runs
  SET status = 'superseded'
  WHERE business_id = v_run.business_id
    AND job_id = v_run.job_id
    AND week_start_date = v_run.week_start_date
    AND status = 'approved'
    AND id <> v_run.id;

  UPDATE public.payroll_runs
  SET status = 'approved',
      approved_by_email = _actor_email,
      approved_at = now()
  WHERE id = v_run.id
  RETURNING * INTO v_run;

  INSERT INTO public.audit_events (
    business_id, actor_user_id, actor_email, entity_type, entity_id, action, reason, changed_fields
  ) VALUES (
    v_run.business_id,
    auth.uid(),
    _actor_email,
    'payroll_run',
    v_run.id::text,
    'payroll_approved',
    v_run.correction_reason,
    jsonb_build_object(
      'week_start_date', v_run.week_start_date,
      'revision', v_run.revision,
      'gross_total_cents', v_run.gross_total_cents,
      'net_total_cents', v_run.net_total_cents
    )
  );

  RETURN v_run;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_payroll_run(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid, text) TO authenticated;