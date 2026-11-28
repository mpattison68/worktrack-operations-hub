ALTER TABLE public.evidence_attachments ADD COLUMN upload_status text NOT NULL DEFAULT 'pending' CHECK(upload_status IN ('pending','uploaded'));
ALTER TABLE public.evidence_attachments ADD COLUMN data_epoch bigint NOT NULL DEFAULT 1;
-- Existing metadata is presumed finalized only if its object exists; never expose missing objects.
UPDATE public.evidence_attachments e SET upload_status='uploaded' WHERE EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id=e.storage_bucket AND o.name=e.storage_path);
GRANT ALL ON public.evidence_attachments,public.sync_idempotency_keys TO service_role;

CREATE OR REPLACE FUNCTION public.worktrack_evidence_allowed(p_business uuid,p_type text,p_entity text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entity uuid; job uuid; found boolean:=false;
BEGIN
 BEGIN entity:=p_entity::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
 CASE p_type
 WHEN 'job' THEN SELECT id,true INTO job,found FROM public.jobs WHERE id=entity AND business_id=p_business;
 WHEN 'assessment' THEN SELECT job_id,true INTO job,found FROM public.assessments WHERE id=entity AND business_id=p_business;
 WHEN 'expense' THEN SELECT job_id,true INTO job,found FROM public.expenses WHERE id=entity AND business_id=p_business;
 WHEN 'vehicle_check' THEN SELECT job_id,true INTO job,found FROM public.asset_checks WHERE id=entity AND business_id=p_business;
 WHEN 'progress_entry' THEN SELECT job_id,true INTO job,found FROM public.progress_entries WHERE id=entity AND business_id=p_business;
 ELSE RETURN false;
 END CASE;
 RETURN coalesce(found,false) AND (public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) OR (job IS NOT NULL AND public.is_assigned_to_job(p_business,job)));
END $$;
REVOKE ALL ON FUNCTION public.worktrack_evidence_allowed(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_evidence_allowed(uuid,text,text) TO authenticated;
DROP POLICY evidence_select_member ON public.evidence_attachments;
DROP POLICY evidence_insert_member ON public.evidence_attachments;
DROP POLICY evidence_delete_admin ON public.evidence_attachments;
CREATE POLICY evidence_select_scoped ON public.evidence_attachments FOR SELECT TO authenticated USING(public.worktrack_evidence_allowed(business_id,linked_entity_type,linked_entity_id) AND data_epoch=(SELECT b.data_epoch FROM public.businesses b WHERE b.id=business_id));
CREATE POLICY evidence_insert_scoped ON public.evidence_attachments FOR INSERT TO authenticated WITH CHECK(uploaded_by=auth.uid() AND upload_status='pending' AND public.worktrack_evidence_allowed(business_id,linked_entity_type,linked_entity_id) AND data_epoch=(SELECT b.data_epoch FROM public.businesses b WHERE b.id=business_id) AND storage_path=business_id::text||'/'||linked_entity_type||'/'||linked_entity_id||'/'||data_epoch::text||'/'||id::text);
CREATE POLICY evidence_delete_unfinished ON public.evidence_attachments FOR DELETE TO authenticated USING(uploaded_by=auth.uid() AND upload_status='pending');

DROP POLICY worktrack_evidence_select_member ON storage.objects;
DROP POLICY worktrack_evidence_insert_member ON storage.objects;
DROP POLICY worktrack_evidence_delete_admin ON storage.objects;
CREATE POLICY worktrack_evidence_select_scoped ON storage.objects FOR SELECT TO authenticated USING(bucket_id='worktrack-evidence' AND EXISTS(SELECT 1 FROM public.evidence_attachments e WHERE e.storage_path=name AND (e.upload_status='uploaded' OR e.uploaded_by=auth.uid()) AND public.worktrack_evidence_allowed(e.business_id,e.linked_entity_type,e.linked_entity_id)));
CREATE POLICY worktrack_evidence_insert_scoped ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='worktrack-evidence' AND EXISTS(SELECT 1 FROM public.evidence_attachments e WHERE e.storage_path=name AND e.upload_status='pending' AND e.uploaded_by=auth.uid() AND public.worktrack_evidence_allowed(e.business_id,e.linked_entity_type,e.linked_entity_id)));
CREATE POLICY worktrack_evidence_delete_unfinished ON storage.objects FOR DELETE TO authenticated USING(bucket_id='worktrack-evidence' AND EXISTS(SELECT 1 FROM public.evidence_attachments e WHERE e.storage_path=name AND e.upload_status='pending' AND e.uploaded_by=auth.uid()));

CREATE OR REPLACE FUNCTION public.worktrack_finalize_evidence(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.evidence_attachments; meta jsonb; BEGIN
 SELECT * INTO e FROM public.evidence_attachments WHERE id=p_id FOR UPDATE;
 IF e.uploaded_by IS DISTINCT FROM auth.uid() OR NOT public.worktrack_evidence_allowed(e.business_id,e.linked_entity_type,e.linked_entity_id) OR e.data_epoch IS DISTINCT FROM (SELECT data_epoch FROM public.businesses WHERE id=e.business_id) THEN RAISE EXCEPTION 'Evidence access denied'; END IF;
 SELECT metadata INTO meta FROM storage.objects WHERE bucket_id=e.storage_bucket AND name=e.storage_path;
 IF meta IS NULL OR coalesce((meta->>'size')::bigint,(meta->>'contentLength')::bigint,0)<>e.file_size_bytes OR meta->>'mimetype' IS DISTINCT FROM e.mime_type THEN RAISE EXCEPTION 'Stored evidence size/type does not match metadata'; END IF;
 UPDATE public.evidence_attachments SET upload_status='uploaded',uploaded_at=now() WHERE id=p_id;
 IF e.linked_entity_type='expense' THEN
  UPDATE public.expenses SET receipt_object_key=e.storage_path,receipt_checksum_sha256=e.sha256_checksum,revision=revision+1 WHERE id=e.linked_entity_id::uuid AND business_id=e.business_id;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_finalize_evidence(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_finalize_evidence(uuid) TO authenticated;

-- RLS must not depend on business management visibility: supervisors can read
-- the tenant epoch, but not mutate or inspect business settings of other tenants.
CREATE POLICY business_member_epoch_read ON public.businesses FOR SELECT TO authenticated USING(public.has_business_role(id,ARRAY['supervisor']::public.app_role[]));
-- Prevent self-assigned foreign-tenant jobs even via privileged UI membership edits.
CREATE OR REPLACE FUNCTION public.worktrack_membership_assignments_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(NEW.assigned_job_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=x AND j.business_id=NEW.business_id)) THEN RAISE EXCEPTION 'Assigned jobs must belong to this business'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_jobs_guard BEFORE INSERT OR UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.worktrack_membership_assignments_guard();
CREATE TRIGGER invitation_jobs_guard BEFORE INSERT OR UPDATE ON public.invitations FOR EACH ROW EXECUTE FUNCTION public.worktrack_membership_assignments_guard();
