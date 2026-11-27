-- WorkTrack Storage Object Policies for Private Evidence Bucket (worktrack-evidence)
-- Portable SQL migration for self-hosted Supabase Storage.
-- Path convention enforced by WorkTrack: <business_id>/<entity_type>/<entity_id>/<file>
-- Ensures authenticated members can only upload/read objects under their own business_id prefix.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'storage'
      AND table_name = 'objects'
  ) THEN
    DROP POLICY IF EXISTS "worktrack_evidence_select_member" ON storage.objects;
    CREATE POLICY "worktrack_evidence_select_member"
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'worktrack-evidence'
        AND EXISTS (
          SELECT 1
          FROM public.memberships m
          WHERE m.business_id::text = (storage.foldername(name))[1]
            AND m.user_id = auth.uid()
            AND m.active = true
        )
      );

    DROP POLICY IF EXISTS "worktrack_evidence_insert_member" ON storage.objects;
    CREATE POLICY "worktrack_evidence_insert_member"
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'worktrack-evidence'
        AND EXISTS (
          SELECT 1
          FROM public.memberships m
          WHERE m.business_id::text = (storage.foldername(name))[1]
            AND m.user_id = auth.uid()
            AND m.active = true
        )
      );

    DROP POLICY IF EXISTS "worktrack_evidence_delete_admin" ON storage.objects;
    CREATE POLICY "worktrack_evidence_delete_admin"
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'worktrack-evidence'
        AND EXISTS (
          SELECT 1
          FROM public.memberships m
          WHERE m.business_id::text = (storage.foldername(name))[1]
            AND m.user_id = auth.uid()
            AND m.active = true
            AND m.role = 'admin'
        )
      );
  END IF;
END $$;

COMMIT;