-- WorkTrack Increment B Extension — Multi-Waypoint GPS Route Capture & Map Baseline
-- Portable PostgreSQL / self-hosted Supabase migration.
-- Extends Increment B while preserving full backward compatibility with start/end-only assessments.

DO $$ BEGIN
  CREATE TYPE public.route_point_type AS ENUM ('start', 'waypoint', 'end');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.route_capture_method AS ENUM ('gps', 'manual_map');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Extend public.assessments with full-precision waypoint & road-network distance columns
-- (kept strictly separate; never auto-substituted) and JSON mirror for fast snapshot reads.
ALTER TABLE public.assessments
  ADD COLUMN IF NOT EXISTS waypoint_measured_distance_meters double precision CHECK (waypoint_measured_distance_meters IS NULL OR waypoint_measured_distance_meters >= 0),
  ADD COLUMN IF NOT EXISTS road_network_distance_meters double precision CHECK (road_network_distance_meters IS NULL OR road_network_distance_meters >= 0),
  ADD COLUMN IF NOT EXISTS route_points_json jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Normalized ordered route points per job assessment
CREATE TABLE IF NOT EXISTS public.assessment_route_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  client_point_id text NOT NULL CHECK (length(trim(client_point_id)) > 0),
  point_type public.route_point_type NOT NULL DEFAULT 'waypoint',
  sequence_number integer NOT NULL CHECK (sequence_number >= 0),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  gps_accuracy_meters double precision CHECK (gps_accuracy_meters IS NULL OR gps_accuracy_meters >= 0),
  captured_at timestamptz NOT NULL DEFAULT now(),
  captured_by uuid REFERENCES auth.users(id),
  captured_by_email text NOT NULL DEFAULT '',
  capture_method public.route_capture_method NOT NULL DEFAULT 'gps',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assessment_id, business_id) REFERENCES public.assessments(id, business_id) ON DELETE CASCADE,
  UNIQUE (assessment_id, sequence_number),
  UNIQUE (assessment_id, client_point_id)
);

CREATE INDEX IF NOT EXISTS idx_assessment_route_points_assessment_seq
  ON public.assessment_route_points (assessment_id, sequence_number);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_route_points TO authenticated;
GRANT ALL ON public.assessment_route_points TO service_role;
ALTER TABLE public.assessment_route_points ENABLE ROW LEVEL SECURITY;

-- RLS Policies: tenant-isolated, read by business members, writeable on draft/returned
-- assessments by owner/supervisor, or anytime by admin (for scope amendments).
CREATE POLICY "route_points_select_members" ON public.assessment_route_points
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner','supervisor']::public.app_role[]));

CREATE POLICY "route_points_insert_authorized" ON public.assessment_route_points
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin']::public.app_role[])
    OR (
      public.has_business_role(business_id, ARRAY['owner','supervisor']::public.app_role[])
      AND EXISTS (
        SELECT 1 FROM public.assessments a
        WHERE a.id = assessment_id
          AND a.business_id = assessment_route_points.business_id
          AND a.status IN ('draft', 'returned')
      )
    )
  );

CREATE POLICY "route_points_update_authorized" ON public.assessment_route_points
  FOR UPDATE TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin']::public.app_role[])
    OR (
      public.has_business_role(business_id, ARRAY['owner','supervisor']::public.app_role[])
      AND EXISTS (
        SELECT 1 FROM public.assessments a
        WHERE a.id = assessment_id
          AND a.business_id = assessment_route_points.business_id
          AND a.status IN ('draft', 'returned')
      )
    )
  )
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin']::public.app_role[])
    OR (
      public.has_business_role(business_id, ARRAY['owner','supervisor']::public.app_role[])
      AND EXISTS (
        SELECT 1 FROM public.assessments a
        WHERE a.id = assessment_id
          AND a.business_id = assessment_route_points.business_id
          AND a.status IN ('draft', 'returned')
      )
    )
  );

CREATE POLICY "route_points_delete_authorized" ON public.assessment_route_points
  FOR DELETE TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin']::public.app_role[])
    OR (
      public.has_business_role(business_id, ARRAY['owner','supervisor']::public.app_role[])
      AND EXISTS (
        SELECT 1 FROM public.assessments a
        WHERE a.id = assessment_id
          AND a.business_id = assessment_route_points.business_id
          AND a.status IN ('draft', 'returned')
      )
    )
  );

-- Audit trail trigger recording route point mutations in public.audit_events
CREATE OR REPLACE FUNCTION public.audit_assessment_route_point_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.assessment_route_points;
  v_actor uuid;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_actor := COALESCE(auth.uid(), v_row.captured_by);
  IF v_actor IS NOT NULL THEN
    INSERT INTO public.audit_events (
      business_id,
      actor_user_id,
      actor_email,
      entity_type,
      entity_id,
      action,
      changed_fields
    ) VALUES (
      v_row.business_id,
      v_actor,
      v_row.captured_by_email,
      'assessment_route_point',
      v_row.assessment_id,
      lower(TG_OP),
      jsonb_build_object(
        'client_point_id', v_row.client_point_id,
        'point_type', v_row.point_type,
        'sequence_number', v_row.sequence_number,
        'latitude', v_row.latitude,
        'longitude', v_row.longitude,
        'capture_method', v_row.capture_method
      )
    );
  END IF;
  RETURN v_row;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_assessment_route_points ON public.assessment_route_points;
CREATE TRIGGER trg_audit_assessment_route_points
  AFTER INSERT OR UPDATE OR DELETE ON public.assessment_route_points
  FOR EACH ROW EXECUTE FUNCTION public.audit_assessment_route_point_change();