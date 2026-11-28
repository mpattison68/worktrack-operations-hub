ALTER TABLE public.businesses ADD COLUMN maintenance_mode boolean NOT NULL DEFAULT false;
-- Legacy clients without a reset epoch cannot write back obsolete records.
CREATE OR REPLACE FUNCTION public.worktrack_epoch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE epoch bigint; maintenance boolean; headers jsonb; supplied bigint; biz uuid;
BEGIN
 IF auth.uid() IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 biz:=(CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END->>'business_id')::uuid;
 SELECT data_epoch,maintenance_mode INTO epoch,maintenance FROM public.businesses WHERE id=biz;
 IF maintenance THEN RAISE EXCEPTION 'Business maintenance in progress; no writes accepted'; END IF;
 headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 supplied:=nullif(headers->>'x-worktrack-epoch','')::bigint;
 IF supplied IS DISTINCT FROM epoch THEN RAISE EXCEPTION 'Obsolete or missing business version; refresh and discard pre-reset drafts' USING ERRCODE='40001'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='business_id' AND table_name NOT IN ('audit_events','admin_operation_log','schema_migrations_worktrack') LOOP
 EXECUTE format('CREATE TRIGGER epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.worktrack_epoch_guard()',t.table_name);
 END LOOP;
END $$;
-- Close supervisor assessment approval/cross-assessment draft access.
DROP POLICY assessments_select_members ON public.assessments;
DROP POLICY assessments_insert_members ON public.assessments;
DROP POLICY assessments_update_draft_or_admin ON public.assessments;
CREATE POLICY assessments_select_scoped ON public.assessments FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]) OR public.is_assigned_to_job(business_id,job_id));
CREATE POLICY assessments_insert_scoped ON public.assessments FOR INSERT TO authenticated WITH CHECK(status='draft' AND revision=1 AND (public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]) OR public.is_assigned_to_job(business_id,job_id)));
CREATE POLICY assessments_update_scoped ON public.assessments FOR UPDATE TO authenticated USING(public.has_business_role(business_id,ARRAY['admin']::public.app_role[]) OR (status IN ('draft','returned') AND (public.has_business_role(business_id,ARRAY['owner']::public.app_role[]) OR public.is_assigned_to_job(business_id,job_id)))) WITH CHECK(public.has_business_role(business_id,ARRAY['admin']::public.app_role[]) OR status IN ('draft','submitted'));
CREATE OR REPLACE FUNCTION public.worktrack_assessment_actor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NOT NULL THEN
  IF TG_OP='INSERT' THEN NEW.created_by:=auth.uid(); SELECT email INTO NEW.created_by_email FROM auth.users WHERE id=auth.uid(); END IF;
  IF NEW.status='approved' AND NOT public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Only Admin approves scope'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER assessment_actor_guard BEFORE INSERT OR UPDATE ON public.assessments FOR EACH ROW EXECUTE FUNCTION public.worktrack_assessment_actor();
-- Server computes check outcomes, so a caller cannot suppress stop-use by flags.
CREATE OR REPLACE FUNCTION public.worktrack_check_outcome() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k text; failed text[]:='{}'; BEGIN
 FOREACH k IN ARRAY ARRAY['oil','coolant','leaks','tyres','brakes_lights','warning_lights'] LOOP
  IF NEW.items->>k IS NULL OR NEW.items->>k <> ALL(ARRAY['ok','problem','not_checked']) THEN RAISE EXCEPTION 'All six safety items must have valid outcomes'; END IF;
  IF (k<>'leaks' AND NEW.items->>k<>'ok') OR (k='leaks' AND NEW.items->>k='problem') THEN failed:=array_append(failed,k); END IF;
 END LOOP;
 NEW.stop_use_triggered:=cardinality(failed)>0; NEW.failed_critical_items:=failed; NEW.sync_status:='synced'; RETURN NEW;
END $$;
CREATE TRIGGER check_outcome BEFORE INSERT ON public.asset_checks FOR EACH ROW EXECUTE FUNCTION public.worktrack_check_outcome();
CREATE OR REPLACE FUNCTION public.worktrack_available_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status='available' AND EXISTS(SELECT 1 FROM public.defects WHERE asset_id=NEW.id AND business_id=NEW.business_id AND severity='critical' AND status='open') THEN RAISE EXCEPTION 'Unresolved critical defect: vehicle unavailable'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER asset_availability_guard BEFORE UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.worktrack_available_guard();
CREATE OR REPLACE FUNCTION public.worktrack_defect_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.severity='critical' AND NEW.status='open' THEN
  UPDATE public.assets SET status='unavailable_defect',updated_at=now() WHERE id=NEW.asset_id AND business_id=NEW.business_id;
  INSERT INTO public.notifications(business_id,type,severity,title,body,dedup_key,link_to) VALUES(NEW.business_id,'vehicle_stop_use','critical','STOP DO NOT USE',NEW.summary,'defect:'||NEW.id,'/vehicles') ON CONFLICT(business_id,dedup_key) DO NOTHING;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER defect_notification AFTER INSERT ON public.defects FOR EACH ROW EXECUTE FUNCTION public.worktrack_defect_alert();
