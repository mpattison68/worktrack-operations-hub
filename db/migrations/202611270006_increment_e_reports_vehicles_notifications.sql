-- WorkTrack Increment E: Weekly Reports, Vehicles/Pre-Use Checks, Defects & Notifications
-- Authoritative spec: docs/specification.md Sections 12, 13, 14, 16, 18
-- Portable PostgreSQL / self-hosted Supabase migration.

CREATE TABLE IF NOT EXISTS public.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN ('truck', 'bakkie', 'trailer', 'brush_cutter', 'chainsaw', 'other')),
  name text NOT NULL,
  make_model text NOT NULL,
  registration text,
  vin text,
  owner_name text NOT NULL,
  purchase_cost_cents bigint CHECK (purchase_cost_cents IS NULL OR purchase_cost_cents >= 0),
  odometer_km integer CHECK (odometer_km IS NULL OR odometer_km >= 0),
  service_interval_km integer CHECK (service_interval_km IS NULL OR service_interval_km > 0),
  last_service_odometer_km integer CHECK (last_service_odometer_km IS NULL OR last_service_odometer_km >= 0),
  licence_expiry_date date,
  insurance_expiry_date date,
  assigned_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable_defect', 'in_service', 'retired')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO authenticated;
GRANT ALL ON public.assets TO service_role;
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY assets_select_member ON public.assets
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]));

CREATE POLICY assets_write_admin_owner ON public.assets
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.asset_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  check_date date NOT NULL,
  odometer_km integer CHECK (odometer_km IS NULL OR odometer_km >= 0),
  items jsonb NOT NULL,
  stop_use_triggered boolean NOT NULL DEFAULT false,
  failed_critical_items text[] NOT NULL DEFAULT '{}',
  comment text NOT NULL DEFAULT '',
  photo_note text,
  captured_offline boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'queued_offline')),
  checked_by_user_id uuid NOT NULL,
  checked_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.asset_checks TO authenticated;
GRANT ALL ON public.asset_checks TO service_role;
ALTER TABLE public.asset_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY asset_checks_select_member ON public.asset_checks
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]));

CREATE POLICY asset_checks_insert_member ON public.asset_checks
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  check_id uuid REFERENCES public.asset_checks(id) ON DELETE SET NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'non_critical')),
  summary text NOT NULL,
  reported_date date NOT NULL,
  reported_by_user_id uuid NOT NULL,
  reported_by_name text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_notes text,
  resolved_by_user_id uuid,
  resolved_by_name text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.defects TO authenticated;
GRANT ALL ON public.defects TO service_role;
ALTER TABLE public.defects ENABLE ROW LEVEL SECURITY;

CREATE POLICY defects_select_member ON public.defects
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]));

CREATE POLICY defects_insert_member ON public.defects
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]));

CREATE POLICY defects_resolve_admin_owner ON public.defects
  FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.asset_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('service', 'repair', 'fuel')),
  odometer_km integer CHECK (odometer_km IS NULL OR odometer_km >= 0),
  litres numeric(10, 2) CHECK (litres IS NULL OR litres > 0),
  cost_cents bigint NOT NULL CHECK (cost_cents >= 0),
  description text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.asset_services TO authenticated;
GRANT ALL ON public.asset_services TO service_role;
ALTER TABLE public.asset_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY asset_services_admin_owner ON public.asset_services
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  week_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'returned', 'approved')),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  locked_snapshot jsonb,
  latest_comment text,
  missing_evidence_acknowledged boolean NOT NULL DEFAULT false,
  submitted_by text,
  submitted_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  revisions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, job_id, week_start)
);

GRANT SELECT, INSERT, UPDATE ON public.weekly_reports TO authenticated;
GRANT ALL ON public.weekly_reports TO service_role;
ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY weekly_reports_select_admin_owner ON public.weekly_reports
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]));

CREATE POLICY weekly_reports_write_admin_owner ON public.weekly_reports
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin', 'owner']::public.app_role[]));

-- Prevent silent edits to locked_snapshot once approved unless an amendment opens draft status
CREATE OR REPLACE FUNCTION public.guard_approved_weekly_report()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'approved' AND NEW.locked_snapshot IS DISTINCT FROM OLD.locked_snapshot THEN
    RAISE EXCEPTION 'Approved weekly report snapshots are immutable; start an amendment revision instead.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_approved_weekly_report ON public.weekly_reports;
CREATE TRIGGER trg_guard_approved_weekly_report
  BEFORE UPDATE ON public.weekly_reports
  FOR EACH ROW EXECUTE FUNCTION public.guard_approved_weekly_report();

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  body text NOT NULL,
  dedup_key text NOT NULL,
  link_to text NOT NULL DEFAULT '/',
  read_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by text,
  delivery_channel text NOT NULL DEFAULT 'in_app',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, dedup_key)
);

GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_member_access ON public.notifications
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  weekly_report_reminder_day text NOT NULL DEFAULT 'sunday' CHECK (weekly_report_reminder_day IN ('sunday', 'monday')),
  weekly_report_reminder_time_sast text NOT NULL DEFAULT '17:00',
  large_expense_threshold_cents bigint NOT NULL DEFAULT 500000 CHECK (large_expense_threshold_cents > 0),
  cash_shortfall_alert_enabled boolean NOT NULL DEFAULT true,
  missing_receipt_alert_enabled boolean NOT NULL DEFAULT true,
  smtp_digest_enabled boolean NOT NULL DEFAULT false,
  smtp_configured boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;
GRANT ALL ON public.notification_preferences TO service_role;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_prefs_select_member ON public.notification_preferences
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin', 'owner', 'supervisor']::public.app_role[]));

CREATE POLICY notification_prefs_write_admin ON public.notification_preferences
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));