-- WorkTrack Increment F: Offline Sync Idempotency, Private Evidence Attachments & Storage Policies
-- Portable SQL migration for self-hosted Supabase PostgreSQL.
-- Runs cleanly via deploy/scripts/migrate.sh with zero Lovable Cloud lock-in.

BEGIN;

-- 1. Server-side idempotency registry for offline replay protection (Acceptance Test T19)
CREATE TABLE IF NOT EXISTS public.sync_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'expense',
      'vehicle_check',
      'progress_entry',
      'attendance',
      'assessment_waypoint',
      'attachment'
    )
  ),
  entity_id text NOT NULL,
  processed_by uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_idempotency_business
  ON public.sync_idempotency_keys (business_id, processed_at DESC);

ALTER TABLE public.sync_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_idempotency_select_member" ON public.sync_idempotency_keys;
CREATE POLICY "sync_idempotency_select_member"
  ON public.sync_idempotency_keys
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.business_id = sync_idempotency_keys.business_id
        AND m.user_id = auth.uid()
        AND m.active = true
    )
  );

DROP POLICY IF EXISTS "sync_idempotency_insert_member" ON public.sync_idempotency_keys;
CREATE POLICY "sync_idempotency_insert_member"
  ON public.sync_idempotency_keys
  FOR INSERT
  TO authenticated
  WITH CHECK (
    processed_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.business_id = sync_idempotency_keys.business_id
        AND m.user_id = auth.uid()
        AND m.active = true
    )
  );

-- 2. Private photo & receipt evidence metadata table (Acceptance Tests T23, T26, T27)
CREATE TABLE IF NOT EXISTS public.evidence_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  linked_entity_type text NOT NULL CHECK (
    linked_entity_type IN ('expense', 'vehicle_check', 'progress_entry', 'assessment', 'job')
  ),
  linked_entity_id text NOT NULL,
  linked_label text NOT NULL DEFAULT '',
  file_name text NOT NULL,
  mime_type text NOT NULL CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  ),
  file_size_bytes integer NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
  sha256_checksum text NOT NULL CHECK (char_length(sha256_checksum) = 64),
  storage_bucket text NOT NULL DEFAULT 'worktrack-evidence' CHECK (storage_bucket = 'worktrack-evidence'),
  storage_path text NOT NULL UNIQUE,
  exif_stripped boolean NOT NULL DEFAULT true,
  location_consented boolean NOT NULL DEFAULT false,
  latitude double precision NULL,
  longitude double precision NULL,
  uploaded_by uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_location_requires_consent CHECK (
    location_consented = true OR (latitude IS NULL AND longitude IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_evidence_attachments_business_entity
  ON public.evidence_attachments (business_id, linked_entity_type, linked_entity_id);

ALTER TABLE public.evidence_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_select_member" ON public.evidence_attachments;
CREATE POLICY "evidence_select_member"
  ON public.evidence_attachments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.business_id = evidence_attachments.business_id
        AND m.user_id = auth.uid()
        AND m.active = true
        AND (
          m.role IN ('admin', 'owner')
          OR evidence_attachments.uploaded_by = auth.uid()
          OR evidence_attachments.linked_entity_id = ANY (m.assigned_job_ids::text[])
        )
    )
  );

DROP POLICY IF EXISTS "evidence_insert_member" ON public.evidence_attachments;
CREATE POLICY "evidence_insert_member"
  ON public.evidence_attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.business_id = evidence_attachments.business_id
        AND m.user_id = auth.uid()
        AND m.active = true
    )
  );

-- Financial & evidence records cannot be hard-deleted by ordinary users (Admin-only retention control)
DROP POLICY IF EXISTS "evidence_delete_admin" ON public.evidence_attachments;
CREATE POLICY "evidence_delete_admin"
  ON public.evidence_attachments
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.business_id = evidence_attachments.business_id
        AND m.user_id = auth.uid()
        AND m.active = true
        AND m.role = 'admin'
    )
  );

-- 3. Private Supabase Storage bucket (no public bucket; short-lived signed URLs only)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'worktrack-evidence',
      'worktrack-evidence',
      false,
      10485760,
      ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    )
    ON CONFLICT (id) DO UPDATE
      SET public = false,
          file_size_limit = 10485760,
          allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  END IF;
END $$;

-- Explicit least-privilege grants (never grant to anon)
REVOKE ALL ON public.sync_idempotency_keys FROM anon;
REVOKE ALL ON public.evidence_attachments FROM anon;
GRANT SELECT, INSERT ON public.sync_idempotency_keys TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.evidence_attachments TO authenticated;

COMMIT;