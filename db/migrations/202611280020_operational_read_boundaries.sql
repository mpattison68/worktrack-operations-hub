-- Supervisors receive operational projections, never raw financial columns.
DROP POLICY jobs_select_assigned_or_mgmt ON public.jobs;
CREATE POLICY jobs_management_read ON public.jobs FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
DROP POLICY workers_select_scoped ON public.workers;
CREATE POLICY workers_management_read ON public.workers FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
DROP POLICY assessments_select_scoped ON public.assessments;
CREATE POLICY assessments_management_read ON public.assessments FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
DO $$ DECLARE p record;BEGIN
 FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='weekly_reports' AND cmd='SELECT' LOOP EXECUTE format('DROP POLICY %I ON public.weekly_reports',p.policyname);END LOOP;
END $$;
CREATE POLICY reports_management_read ON public.weekly_reports FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE OR REPLACE FUNCTION public.worktrack_redact_report(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p IS NULL THEN NULL ELSE p-ARRAY['payrollRunId','payrollRunStatus','wagesEarnedCents','wagesPaidCents','priorArrearsCents','expensesIncurredCents','cashSpentCents','inflowsCents','sourceIds']||jsonb_build_object('payrollRunId',null,'payrollRunStatus',null,'wagesEarnedCents',0,'wagesPaidCents',0,'priorArrearsCents',0,'expensesIncurredCents',0,'cashSpentCents',0,'inflowsCents',0) END;
$$;
CREATE OR REPLACE FUNCTION public.worktrack_operational_read(p_business uuid,p_table text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner','supervisor']::public.app_role[]) THEN RAISE EXCEPTION 'Active business membership required';END IF;
 CASE p_table
 WHEN 'jobs' THEN SELECT coalesce(jsonb_agg(to_jsonb(j)-ARRAY['contract_value_cents','opening_cash_allocation_cents']||jsonb_build_object('contract_value_cents',0,'opening_cash_allocation_cents',0)),'[]') INTO result FROM jobs j WHERE business_id=p_business AND public.is_assigned_to_job(p_business,j.id);
 WHEN 'workers' THEN SELECT coalesce(jsonb_agg(to_jsonb(w)-ARRAY['opening_balance_cents','opening_balance_source','opening_balance_verified']||jsonb_build_object('opening_balance_cents',0,'opening_balance_source','Restricted','opening_balance_verified',false)),'[]') INTO result FROM workers w WHERE business_id=p_business AND EXISTS(SELECT 1 FROM worker_assignments a WHERE a.business_id=p_business AND a.worker_id=w.id AND public.is_assigned_to_job(p_business,a.job_id));
 WHEN 'assessments' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(a)-ARRAY['road_worker_daily_rate_cents','cook_weekly_rate_cents','contract_value_cents','budget_lines_json','revisions_json']||jsonb_build_object('road_worker_daily_rate_cents',0,'cook_weekly_rate_cents',0,'contract_value_cents',0,'budget_lines_json','[]'::jsonb,'revisions_json',(SELECT coalesce(jsonb_agg(r-ARRAY['estimatedLabourCents','estimatedOperatingCents','estimatedCapitalCents','contractValueCents'] ORDER BY ord),'[]') FROM jsonb_array_elements(a.revisions_json) WITH ORDINALITY x(r,ord)))),'[]') INTO result FROM assessments a WHERE business_id=p_business AND public.is_assigned_to_job(p_business,a.job_id);
 WHEN 'weekly_reports' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(w)-ARRAY['locked_snapshot','revisions_json']||jsonb_build_object('locked_snapshot',public.worktrack_redact_report(w.locked_snapshot),'revisions_json',(SELECT coalesce(jsonb_agg(r||jsonb_build_object('snapshot',public.worktrack_redact_report(r->'snapshot')) ORDER BY ord),'[]') FROM jsonb_array_elements(w.revisions_json) WITH ORDINALITY x(r,ord)))),'[]') INTO result FROM weekly_reports w WHERE business_id=p_business AND public.is_assigned_to_job(p_business,w.job_id);
 ELSE RAISE EXCEPTION 'Unsupported operational projection';END CASE;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_operational_read(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_operational_read(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.worktrack_redact_report(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_redact_report(jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.worktrack_progress_review_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.verification_state='verified' THEN NEW.verification_state:='reported';END IF;
  SELECT email INTO NEW.submitted_by_email FROM auth.users WHERE id=auth.uid();
 ELSIF NEW.verification_state IS DISTINCT FROM OLD.verification_state AND NOT public.has_business_role(NEW.business_id,ARRAY['admin','owner']::public.app_role[]) THEN RAISE EXCEPTION 'Management review required';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER progress_review_guard BEFORE INSERT OR UPDATE ON public.progress_entries FOR EACH ROW EXECUTE FUNCTION public.worktrack_progress_review_guard();
DROP POLICY sync_idempotency_select_member ON public.sync_idempotency_keys;
CREATE POLICY own_replay_receipts ON public.sync_idempotency_keys FOR SELECT TO authenticated USING(processed_by=auth.uid() AND public.has_business_role(business_id,ARRAY['admin','owner','supervisor']::public.app_role[]));

CREATE OR REPLACE FUNCTION public.worktrack_save_assessment(p_business uuid,p_epoch bigint,p_payload jsonb,p_expected_version integer,p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE replay jsonb; a public.assessments; previous public.assessments; wanted public.assessment_status; point jsonb; seq integer:=0; actor_email text;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) THEN RAISE EXCEPTION 'Assessment access denied'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 IF (SELECT data_epoch FROM public.businesses WHERE id=p_business)<>p_epoch THEN RAISE EXCEPTION 'Obsolete assessment draft'; END IF;
 SELECT result_json INTO replay FROM public.sync_idempotency_keys WHERE business_id=p_business AND idempotency_key=p_key AND processed_by=auth.uid();
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 SELECT email INTO actor_email FROM auth.users WHERE id=auth.uid();
 a:=jsonb_populate_record(NULL::public.assessments,p_payload||jsonb_build_object('business_id',p_business,'id',coalesce(p_payload->>'id',gen_random_uuid()::text),'created_by',auth.uid(),'created_by_email',actor_email,'created_at',now(),'updated_at',now()));
 SELECT * INTO previous FROM public.assessments WHERE id=a.id AND business_id=p_business FOR UPDATE;
 IF previous.id IS NOT NULL AND previous.edit_version<>p_expected_version THEN RETURN jsonb_build_object('status','conflict','server',to_jsonb(previous),'revision',previous.edit_version); END IF;
 IF previous.status IN ('approved','submitted') AND NOT public.has_business_role(p_business,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Submitted or approved scope is locked; Admin must return or amend it'; END IF;
 a.edit_version:=coalesce(previous.edit_version,0)+1;
 wanted:=a.status;
 IF wanted IN ('submitted','approved') AND a.accepted_distance_meters<=0 THEN RAISE EXCEPTION 'Positive road distance required for submission'; END IF;
 IF wanted='approved' AND NOT public.has_business_role(p_business,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Only Admin approves'; END IF;
 IF previous.id IS NULL THEN
  a.status:='draft';a.revision:=1;
  INSERT INTO public.assessments SELECT a.*;
 ELSE
  a.created_at:=previous.created_at;a.created_by:=previous.created_by;a.created_by_email:=previous.created_by_email;
 END IF;
 a.status:=wanted;
 IF wanted='approved' AND a.job_id IS NULL THEN
  INSERT INTO public.jobs(business_id,name,customer_name,road_or_area,contract_reference,contract_value_cents,status,created_by,work_requirements)
  VALUES(p_business,a.name,a.customer_name,a.road_or_area,'ASMT-REV-'||a.revision,a.contract_value_cents,'planned',auth.uid(),'Approved assessment '||a.id) RETURNING id INTO a.job_id;
  INSERT INTO public.job_revisions(business_id,job_id,revision,snapshot,reason,approved_by)
  SELECT p_business,j.id,1,to_jsonb(j),'Approved assessment baseline',auth.uid() FROM public.jobs j WHERE id=a.job_id;
 END IF;
 UPDATE public.assessments SET job_id=a.job_id,name=a.name,customer_name=a.customer_name,road_or_area=a.road_or_area,direction_description=a.direction_description,status=a.status,revision=a.revision,start_gps=a.start_gps,end_gps=a.end_gps,gps_unavailable_reason=a.gps_unavailable_reason,distance_source=a.distance_source,original_distance_meters=a.original_distance_meters,accepted_distance_meters=a.accepted_distance_meters,distance_override_reason=a.distance_override_reason,distance_provisional=a.distance_provisional,sections_json=a.sections_json,exclusions=a.exclusions,benchmark_id=a.benchmark_id,benchmark_productivity_sqm=a.benchmark_productivity_sqm,benchmark_confidence=a.benchmark_confidence,productive_crew_size=a.productive_crew_size,road_worker_daily_rate_cents=a.road_worker_daily_rate_cents,cook_weekly_rate_cents=a.cook_weekly_rate_cents,include_cook=a.include_cook,workdays_per_week=a.workdays_per_week,contract_value_cents=a.contract_value_cents,budget_lines_json=a.budget_lines_json,review_comment=a.review_comment,revisions_json=a.revisions_json,route_points_json=a.route_points_json,waypoint_measured_distance_meters=a.waypoint_measured_distance_meters,road_network_distance_meters=a.road_network_distance_meters,updated_at=now(),edit_version=a.edit_version WHERE id=a.id;
 DELETE FROM public.assessment_route_points WHERE assessment_id=a.id AND business_id=p_business;
 FOR point IN SELECT value FROM jsonb_array_elements(coalesce(a.route_points_json,'[]')) LOOP
  INSERT INTO public.assessment_route_points(business_id,assessment_id,client_point_id,point_type,sequence_number,latitude,longitude,gps_accuracy_meters,captured_at,captured_by,captured_by_email,capture_method)
  VALUES(p_business,a.id,point->>'clientPointId',(point->>'pointType')::public.route_point_type,seq,(point->>'latitude')::double precision,(point->>'longitude')::double precision,(point->>'gpsAccuracyMeters')::double precision,coalesce((point->>'capturedAt')::timestamptz,now()),auth.uid(),actor_email,(point->>'captureMethod')::public.route_capture_method);
  seq:=seq+1;
 END LOOP;
 replay:=jsonb_build_object('status','saved','record',to_jsonb(a));
 IF p_key IS NOT NULL THEN INSERT INTO public.sync_idempotency_keys(business_id,idempotency_key,entity_type,entity_id,processed_by,result_json) VALUES(p_business,p_key,'assessment_waypoint',a.id::text,auth.uid(),replay);END IF;
 RETURN replay;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_save_assessment(uuid,bigint,jsonb,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_save_assessment(uuid,bigint,jsonb,integer,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.worktrack_capture_offline(p_business uuid,p_epoch bigint,p_key text,p_kind text,p_payload jsonb,p_base_revision integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; job uuid; actor_email text; oldrow jsonb; newrow jsonb; target uuid; base integer; side text; created uuid; table_name text;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner','supervisor']::public.app_role[]) THEN RAISE EXCEPTION 'Active membership required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 IF (SELECT data_epoch FROM public.businesses WHERE id=p_business)<>p_epoch OR (SELECT maintenance_mode FROM public.businesses WHERE id=p_business) THEN RAISE EXCEPTION 'Obsolete offline draft or maintenance mode'; END IF;
 SELECT result_json INTO result FROM public.sync_idempotency_keys WHERE business_id=p_business AND idempotency_key=p_key AND processed_by=auth.uid();
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT email INTO actor_email FROM auth.users WHERE id=auth.uid();
 job:=(p_payload->>'job_id')::uuid;
 IF p_kind IN ('team','exception','progress') AND (job IS NULL OR NOT public.is_assigned_to_job(p_business,job)) THEN RAISE EXCEPTION 'Assigned job required'; END IF;
 IF p_kind IN ('team','exception') THEN
  table_name:=CASE WHEN p_kind='team' THEN 'team_days' ELSE 'attendance_entries' END;
  IF p_kind='exception' AND NOT EXISTS(SELECT 1 FROM public.worker_assignments wa WHERE wa.business_id=p_business AND wa.worker_id=(p_payload->>'worker_id')::uuid AND wa.job_id=job AND wa.assigned_from<=(p_payload->>'work_date')::date AND (wa.assigned_to IS NULL OR wa.assigned_to>=(p_payload->>'work_date')::date)) THEN RAISE EXCEPTION 'Worker is not assigned on this date'; END IF;
  IF p_kind='team' THEN SELECT to_jsonb(t) INTO oldrow FROM public.team_days t WHERE business_id=p_business AND job_id=job AND work_date=(p_payload->>'work_date')::date;
  ELSE SELECT to_jsonb(t) INTO oldrow FROM public.attendance_entries t WHERE business_id=p_business AND job_id=job AND worker_id=(p_payload->>'worker_id')::uuid AND work_date=(p_payload->>'work_date')::date;END IF;
  base:=coalesce((oldrow->>'revision')::int,0);
  IF base<>p_base_revision THEN RETURN jsonb_build_object('status','conflict','server',oldrow,'revision',base); END IF;
  target:=coalesce((oldrow->>'id')::uuid,gen_random_uuid());
  newrow:=p_payload||jsonb_build_object('id',target,'business_id',p_business,'revision',base+1,'updated_by_email',actor_email,'updated_at',now());
  IF p_kind='team' THEN
   INSERT INTO public.team_days SELECT (jsonb_populate_record(NULL::public.team_days,newrow)).* ON CONFLICT(business_id,job_id,work_date) DO UPDATE SET day_status=excluded.day_status,normal_hours=excluded.normal_hours,weekday_ot_hours=excluded.weekday_ot_hours,saturday_hours=excluded.saturday_hours,sunday_hours=excluded.sunday_hours,public_holiday_hours=excluded.public_holiday_hours,interruption_reason=excluded.interruption_reason,notes=excluded.notes,revision=excluded.revision,updated_by_email=excluded.updated_by_email,updated_at=excluded.updated_at;
  ELSE
   INSERT INTO public.attendance_entries SELECT (jsonb_populate_record(NULL::public.attendance_entries,newrow||jsonb_build_object('is_override',true))).* ON CONFLICT(business_id,worker_id,job_id,work_date) DO UPDATE SET day_status=excluded.day_status,normal_hours=excluded.normal_hours,weekday_ot_hours=excluded.weekday_ot_hours,saturday_hours=excluded.saturday_hours,sunday_hours=excluded.sunday_hours,public_holiday_hours=excluded.public_holiday_hours,is_override=true,override_reason=excluded.override_reason,revision=excluded.revision,updated_by_email=excluded.updated_by_email,updated_at=excluded.updated_at;
  END IF;
 ELSIF p_kind='progress' THEN
  target:=gen_random_uuid();
  FOR side IN SELECT jsonb_array_elements_text(p_payload->'verge_sides') LOOP
   created:=gen_random_uuid();
   newrow:=(p_payload-'verge_sides')||jsonb_build_object('id',created,'business_id',p_business,'verge_side',side,'revision',1,'submitted_by_email',actor_email,'verification_state','reported','created_at',now(),'updated_at',now());
   INSERT INTO public.progress_entries SELECT (jsonb_populate_record(NULL::public.progress_entries,newrow)).*;
   target:=created;
  END LOOP;
 ELSE RAISE EXCEPTION 'Unsupported offline capture';
 END IF;
 result:=jsonb_build_object('status','saved','entityId',target);
 INSERT INTO public.sync_idempotency_keys(business_id,idempotency_key,entity_type,entity_id,processed_by,result_json) VALUES(p_business,p_key,CASE WHEN p_kind='progress' THEN 'progress_entry' ELSE 'attendance' END,target::text,auth.uid(),result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_capture_offline(uuid,bigint,text,text,jsonb,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_capture_offline(uuid,bigint,text,text,jsonb,integer) TO authenticated;
