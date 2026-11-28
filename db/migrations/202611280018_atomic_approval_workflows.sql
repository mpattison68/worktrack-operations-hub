-- Forward-only; no change to existing applied migration files.
ALTER TABLE public.payroll_runs ADD COLUMN source_token text NOT NULL DEFAULT '';
CREATE OR REPLACE FUNCTION public.worktrack_payroll_source_token(p_business uuid,p_job uuid,p_week date)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result text;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) THEN RAISE EXCEPTION 'Payroll access denied'; END IF;
 SELECT md5(jsonb_build_object(
 'workers',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM workers t WHERE business_id=p_business),
 'roles',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM worker_roles t WHERE business_id=p_business),
 'rules',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM pay_rules t WHERE business_id=p_business),
 'overrides',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM worker_rate_overrides t WHERE business_id=p_business),
 'assignments',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM worker_assignments t WHERE business_id=p_business),
 'team',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM team_days t WHERE business_id=p_business AND job_id=p_job AND work_date BETWEEN p_week AND p_week+6),
 'attendance',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM attendance_entries t WHERE business_id=p_business AND work_date BETWEEN p_week AND p_week+6)
 )::text) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_payroll_source_token(uuid,uuid,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_payroll_source_token(uuid,uuid,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.worktrack_payroll_ready(p_business uuid,p_job uuid,p_week date)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH eligible AS (
 SELECT DISTINCT w.*,r.shares_crew_schedule FROM workers w JOIN worker_roles r ON r.id=w.worker_role_id AND r.business_id=w.business_id
 JOIN worker_assignments wa ON wa.worker_id=w.id AND wa.business_id=w.business_id
 WHERE w.business_id=p_business AND wa.job_id=p_job AND wa.assigned_from<=p_week+6 AND (wa.assigned_to IS NULL OR wa.assigned_to>=p_week)
 ), days AS (
 SELECT w.id worker_id,d::date work_date,
 coalesce(a.day_status,CASE WHEN w.shares_crew_schedule THEN t.day_status END,'unknown') state,
 coalesce(a.weekday_ot_hours,CASE WHEN w.shares_crew_schedule THEN t.weekday_ot_hours END,0) ot,
 coalesce(a.saturday_hours,CASE WHEN w.shares_crew_schedule THEN t.saturday_hours END,0) sat,
 coalesce(a.sunday_hours,CASE WHEN w.shares_crew_schedule THEN t.sunday_hours END,0) sun,
 coalesce(a.public_holiday_hours,CASE WHEN w.shares_crew_schedule THEN t.public_holiday_hours END,0) holiday,
 pr.id rule_id,pr.is_confirmed,pr.weekday_ot_hourly_cents,pr.saturday_rate_cents,pr.sunday_rate_cents,pr.public_holiday_rate_cents
 FROM eligible w CROSS JOIN generate_series(p_week::timestamp,(p_week+6)::timestamp,interval '1 day') d
 LEFT JOIN attendance_entries a ON a.business_id=p_business AND a.job_id=p_job AND a.worker_id=w.id AND a.work_date=d::date
 LEFT JOIN team_days t ON t.business_id=p_business AND t.job_id=p_job AND t.work_date=d::date
 LEFT JOIN LATERAL (SELECT * FROM pay_rules p WHERE p.business_id=p_business AND p.worker_role_id=w.worker_role_id AND p.effective_from<=d::date AND (p.effective_to IS NULL OR p.effective_to>=d::date) ORDER BY p.effective_from DESC LIMIT 1) pr ON true
 )
 SELECT public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) AND EXISTS(SELECT 1 FROM eligible)
 AND NOT EXISTS(SELECT 1 FROM days WHERE state='unknown' OR is_confirmed=false OR (state IN ('worked','partial') AND rule_id IS NULL) OR (ot>0 AND weekday_ot_hourly_cents IS NULL) OR (sat>0 AND saturday_rate_cents IS NULL) OR (sun>0 AND sunday_rate_cents IS NULL) OR (holiday>0 AND public_holiday_rate_cents IS NULL))
 AND NOT EXISTS(SELECT 1 FROM attendance_entries a JOIN days d ON a.worker_id=d.worker_id AND a.work_date=d.work_date WHERE a.business_id=p_business AND a.job_id<>p_job AND a.day_status IN ('worked','partial') AND d.state IN ('worked','partial'));
$$;
REVOKE ALL ON FUNCTION public.worktrack_payroll_ready(uuid,uuid,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_payroll_ready(uuid,uuid,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_approved_payroll_immutability() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 IF OLD.status IN ('approved','superseded') THEN
  IF TG_OP='UPDATE' AND OLD.status='approved' AND NEW.status='superseded' AND (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status') THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Approved payroll history is immutable; create a correction revision';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.approve_payroll_run(_run_id uuid,_actor_email text)
RETURNS public.payroll_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.payroll_runs; actor_email text; totals record;
BEGIN
 SELECT * INTO r FROM payroll_runs WHERE id=_run_id FOR UPDATE;
 IF NOT FOUND OR NOT public.has_business_role(r.business_id,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Only Admin can approve payroll'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.business_id::text,0));
 IF r.status<>'draft' THEN RAISE EXCEPTION 'Only draft payroll can be approved'; END IF;
 IF r.source_token='' OR r.source_token<>public.worktrack_payroll_source_token(r.business_id,r.job_id,r.week_start_date) THEN RAISE EXCEPTION 'Payroll inputs changed; recalculate before approval'; END IF;
 IF NOT public.worktrack_payroll_ready(r.business_id,r.job_id,r.week_start_date) THEN RAISE EXCEPTION 'Unknown attendance, unconfirmed/missing rates or overlapping attendance blocks approval'; END IF;
 SELECT count(*) n,sum(gross_pay_cents) gross,sum(adjustments_cents) adjustments,sum(deductions_cents) deductions,sum(net_pay_cents) net INTO totals FROM payroll_earnings WHERE payroll_run_id=r.id AND business_id=r.business_id;
 IF totals.n=0 OR totals.gross IS DISTINCT FROM r.gross_total_cents OR totals.adjustments IS DISTINCT FROM r.adjustments_total_cents OR totals.deductions IS DISTINCT FROM r.deductions_total_cents OR totals.net IS DISTINCT FROM r.net_total_cents THEN RAISE EXCEPTION 'Payroll totals must match complete earnings'; END IF;
 IF EXISTS(SELECT 1 FROM payroll_runs WHERE business_id=r.business_id AND job_id=r.job_id AND week_start_date=r.week_start_date AND status='approved') AND length(trim(coalesce(r.correction_reason,'')))=0 THEN RAISE EXCEPTION 'Correction reason required'; END IF;
 SELECT email INTO actor_email FROM auth.users WHERE id=auth.uid();
 UPDATE payroll_runs SET status='superseded' WHERE business_id=r.business_id AND job_id=r.job_id AND week_start_date=r.week_start_date AND status='approved';
 UPDATE payroll_runs SET status='approved',approved_by_email=actor_email,approved_at=now() WHERE id=r.id RETURNING * INTO r;
 INSERT INTO audit_events(business_id,actor_user_id,actor_email,entity_type,entity_id,action,reason) VALUES(r.business_id,auth.uid(),actor_email,'payroll_run',r.id,'payroll_approved',r.correction_reason);
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.approve_payroll_run(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.worktrack_save_payroll(p_business uuid,p_epoch bigint,p_run jsonb,p_earnings jsonb,p_adjustments jsonb,p_source_token text,p_expected_revision integer,p_approve boolean)
RETURNS public.payroll_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.payroll_runs; line jsonb; actor_email text; current_revision integer; prior uuid;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) OR (p_approve AND NOT public.has_business_role(p_business,ARRAY['admin']::public.app_role[])) THEN RAISE EXCEPTION 'Payroll permission denied'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 IF (SELECT data_epoch<>p_epoch OR maintenance_mode FROM businesses WHERE id=p_business) THEN RAISE EXCEPTION 'Obsolete business epoch or maintenance'; END IF;
 SELECT email INTO actor_email FROM auth.users WHERE id=auth.uid();
 r:=jsonb_populate_record(NULL::public.payroll_runs,p_run||jsonb_build_object('business_id',p_business,'status','draft','source_token',p_source_token,'created_by_email',actor_email,'created_at',now(),'approved_at',null,'approved_by_email',null));
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=r.job_id AND business_id=p_business) OR extract(isodow FROM r.week_start_date)<>1 THEN RAISE EXCEPTION 'Valid business job and Monday required'; END IF;
 IF p_source_token IS DISTINCT FROM public.worktrack_payroll_source_token(p_business,r.job_id,r.week_start_date) THEN RAISE EXCEPTION 'Payroll inputs changed; recalculate'; END IF;
 SELECT coalesce(max(revision),0) INTO current_revision FROM payroll_runs WHERE business_id=p_business AND job_id=r.job_id AND week_start_date=r.week_start_date;
 IF current_revision<>p_expected_revision OR r.revision<>current_revision+1 THEN RAISE EXCEPTION 'Payroll revision changed; refresh' USING ERRCODE='40001'; END IF;
 SELECT id INTO prior FROM payroll_runs WHERE business_id=p_business AND job_id=r.job_id AND week_start_date=r.week_start_date AND status='approved';
 r.supersedes_run_id:=prior;
 IF prior IS NOT NULL AND length(trim(coalesce(r.correction_reason,'')))=0 THEN RAISE EXCEPTION 'Correction reason required'; END IF;
 INSERT INTO payroll_runs SELECT r.*;
 FOR line IN SELECT value FROM jsonb_array_elements(p_earnings) LOOP
  INSERT INTO payroll_earnings SELECT (jsonb_populate_record(NULL::public.payroll_earnings,line||jsonb_build_object('id',gen_random_uuid(),'business_id',p_business,'payroll_run_id',r.id,'created_at',now()))).*;
 END LOOP;
 FOR line IN SELECT value FROM jsonb_array_elements(p_adjustments) LOOP
  INSERT INTO payroll_adjustments SELECT (jsonb_populate_record(NULL::public.payroll_adjustments,line||jsonb_build_object('business_id',p_business,'payroll_run_id',r.id,'approved_by_email',actor_email,'created_at',now()))).*;
 END LOOP;
 IF EXISTS(SELECT 1 FROM payroll_earnings WHERE payroll_run_id=r.id AND gross_pay_cents+adjustments_cents-deductions_cents<>net_pay_cents) THEN RAISE EXCEPTION 'Invalid earning arithmetic'; END IF;
 IF EXISTS(SELECT 1 FROM worker_assignments wa WHERE wa.business_id=p_business AND wa.job_id=r.job_id AND wa.assigned_from<=r.week_end_date AND (wa.assigned_to IS NULL OR wa.assigned_to>=r.week_start_date) AND NOT EXISTS(SELECT 1 FROM payroll_earnings e WHERE e.payroll_run_id=r.id AND e.worker_id=wa.worker_id)) OR EXISTS(SELECT 1 FROM payroll_earnings e WHERE e.payroll_run_id=r.id AND NOT EXISTS(SELECT 1 FROM worker_assignments wa WHERE wa.business_id=p_business AND wa.job_id=r.job_id AND wa.worker_id=e.worker_id AND wa.assigned_from<=r.week_end_date AND (wa.assigned_to IS NULL OR wa.assigned_to>=r.week_start_date))) THEN RAISE EXCEPTION 'Earnings must cover exactly the assigned workers';END IF;
 IF p_approve THEN r:=public.approve_payroll_run(r.id,actor_email); END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_save_payroll(uuid,bigint,jsonb,jsonb,jsonb,text,integer,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_save_payroll(uuid,bigint,jsonb,jsonb,jsonb,text,integer,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.worktrack_report_transition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_count integer:=0; new_count integer; prefix jsonb; last_revision jsonb; snap jsonb; actor_name text;
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  old_count:=jsonb_array_length(OLD.revisions_json);
  SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO prefix FROM jsonb_array_elements(NEW.revisions_json) WITH ORDINALITY x(value,ord) WHERE ord<=old_count;
  IF prefix<>OLD.revisions_json THEN RAISE EXCEPTION 'Exact ordered report history must be preserved'; END IF;
  IF OLD.status='approved' AND NEW.status='draft' THEN RETURN NEW; END IF;
  IF NOT ((OLD.status IN ('draft','returned') AND NEW.status='submitted') OR (OLD.status='submitted' AND NEW.status IN ('approved','returned'))) THEN RAISE EXCEPTION 'Invalid report transition'; END IF;
  IF NEW.current_revision<>OLD.current_revision+(CASE WHEN NEW.status='submitted' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Invalid report revision number'; END IF;
 END IF;
 new_count:=jsonb_array_length(NEW.revisions_json);
 IF new_count<>old_count+1 THEN RAISE EXCEPTION 'Exactly one report review event required'; END IF;
 last_revision:=NEW.revisions_json->(new_count-1);snap:=last_revision->'snapshot';
 IF last_revision->>'status'<>NEW.status::text OR (last_revision->>'revisionNumber')::int<>NEW.current_revision OR snap->>'jobId'<>NEW.job_id::text OR snap->>'businessId'<>NEW.business_id::text THEN RAISE EXCEPTION 'Report event and snapshot must match parent'; END IF;
 IF NEW.status IN ('approved','returned') THEN
  IF NOT public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Admin review required'; END IF;
  IF snap IS DISTINCT FROM (OLD.revisions_json->(old_count-1)->'snapshot') THEN RAISE EXCEPTION 'Review must preserve submitted snapshot'; END IF;
  IF NEW.status='returned' AND length(trim(coalesce(NEW.latest_comment,'')))=0 THEN RAISE EXCEPTION 'Return comments required'; END IF;
  IF NEW.status='approved' AND NEW.locked_snapshot IS DISTINCT FROM snap THEN RAISE EXCEPTION 'Approval must lock the submitted snapshot'; END IF;
 END IF;
 IF NEW.status='submitted' AND (coalesce((snap->>'missingReceiptsCount')::int,0)>0 OR coalesce((snap->>'truckChecksCount')::int,0)=0) AND NOT NEW.missing_evidence_acknowledged THEN RAISE EXCEPTION 'Missing evidence acknowledgement required'; END IF;
 SELECT full_name INTO actor_name FROM memberships WHERE business_id=NEW.business_id AND user_id=auth.uid() AND active;
 NEW.revisions_json:=prefix; -- rebuilt below; no caller-selected reviewer identity
 IF TG_OP='INSERT' THEN NEW.revisions_json:='[]'; ELSE NEW.revisions_json:=OLD.revisions_json; END IF;
 NEW.revisions_json:=NEW.revisions_json||jsonb_build_array(last_revision||jsonb_build_object('actorUserId',auth.uid(),'actorName',actor_name,'createdAt',now()));
 IF NEW.status='submitted' THEN NEW.submitted_by:=actor_name;NEW.submitted_at:=now(); ELSE NEW.reviewed_by:=actor_name;NEW.reviewed_at:=now(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_report_transition BEFORE INSERT OR UPDATE ON public.weekly_reports FOR EACH ROW EXECUTE FUNCTION public.worktrack_report_transition();

-- Assessment, route and linked planned job commit or roll back together.
CREATE OR REPLACE FUNCTION public.worktrack_save_assessment(p_business uuid,p_epoch bigint,p_payload jsonb,p_expected_version integer,p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE replay jsonb; a public.assessments; previous public.assessments; wanted public.assessment_status; point jsonb; seq integer:=0; actor_email text;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) THEN RAISE EXCEPTION 'Assessment access denied'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 IF (SELECT data_epoch FROM public.businesses WHERE id=p_business)<>p_epoch THEN RAISE EXCEPTION 'Obsolete assessment draft'; END IF;
 SELECT result_json INTO replay FROM public.sync_idempotency_keys WHERE business_id=p_business AND idempotency_key=p_key;
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

