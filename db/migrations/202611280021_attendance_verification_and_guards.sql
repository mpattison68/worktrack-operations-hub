-- Enforce attendance verification, assignment/hour invariants, and approved-week locks.
-- Also tighten progress_entries insert RLS alongside the progress_review_guard trigger.

DROP POLICY IF EXISTS progress_entries_insert ON public.progress_entries;
CREATE POLICY progress_entries_insert ON public.progress_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    verification_state <> 'verified'
    AND (
      public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
      OR public.is_assigned_to_job(business_id, job_id)
    )
  );

ALTER TABLE public.team_days
  ADD COLUMN IF NOT EXISTS verification_state text NOT NULL DEFAULT 'verified'
  CHECK (verification_state IN ('reported', 'verified'));

ALTER TABLE public.attendance_entries
  ADD COLUMN IF NOT EXISTS verification_state text NOT NULL DEFAULT 'verified'
  CHECK (verification_state IN ('reported', 'verified'));

DROP POLICY IF EXISTS team_days_write ON public.team_days;
CREATE POLICY team_days_insert ON public.team_days
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (public.is_assigned_to_job(business_id, job_id) AND verification_state = 'reported')
  );
CREATE POLICY team_days_update ON public.team_days
  FOR UPDATE TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (public.is_assigned_to_job(business_id, job_id) AND verification_state = 'reported')
  )
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (public.is_assigned_to_job(business_id, job_id) AND verification_state = 'reported')
  );
CREATE POLICY team_days_delete ON public.team_days
  FOR DELETE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

DROP POLICY IF EXISTS attendance_entries_write ON public.attendance_entries;
CREATE POLICY attendance_entries_insert ON public.attendance_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (public.is_assigned_to_job(business_id, job_id) AND verification_state = 'reported')
  );
CREATE POLICY attendance_entries_update ON public.attendance_entries
  FOR UPDATE TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (public.is_assigned_to_job(business_id, job_id) AND verification_state = 'reported')
  )
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (public.is_assigned_to_job(business_id, job_id) AND verification_state = 'reported')
  );
CREATE POLICY attendance_entries_delete ON public.attendance_entries
  FOR DELETE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE OR REPLACE FUNCTION public.worktrack_attendance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  is_mgmt boolean;
  target_business uuid;
  target_job uuid;
  target_date date;
  total_hours numeric;
  actor_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  target_business := CASE WHEN TG_OP = 'DELETE' THEN OLD.business_id ELSE NEW.business_id END;
  target_job := CASE WHEN TG_OP = 'DELETE' THEN OLD.job_id ELSE NEW.job_id END;
  target_date := CASE WHEN TG_OP = 'DELETE' THEN OLD.work_date ELSE NEW.work_date END;
  is_mgmt := public.has_business_role(target_business, ARRAY['admin','owner']::public.app_role[]);

  IF NOT is_mgmt AND EXISTS (
    SELECT 1 FROM public.payroll_runs pr
    WHERE pr.business_id = target_business
      AND pr.job_id = target_job
      AND pr.status = 'approved'
      AND target_date BETWEEN pr.week_start_date AND pr.week_end_date
  ) THEN
    RAISE EXCEPTION 'Approved payroll week attendance can only be amended by management';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT is_mgmt THEN
      RAISE EXCEPTION 'Only management can delete attendance records';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT is_mgmt AND OLD.verification_state = 'verified' THEN
    RAISE EXCEPTION 'Verified attendance can only be modified by management';
  END IF;

  total_hours :=
    coalesce(NEW.normal_hours, 0)
    + coalesce(NEW.weekday_ot_hours, 0)
    + coalesce(NEW.saturday_hours, 0)
    + coalesce(NEW.sunday_hours, 0)
    + coalesce(NEW.public_holiday_hours, 0);

  IF NEW.day_status IN ('no_work', 'absent', 'unknown') AND total_hours <> 0 THEN
    RAISE EXCEPTION 'Non-working attendance status cannot carry worked hours';
  END IF;
  IF NEW.day_status IN ('worked', 'partial') AND (total_hours <= 0 OR total_hours > 24) THEN
    RAISE EXCEPTION 'Worked or partial attendance must record between 0 and 24 hours';
  END IF;

  IF TG_TABLE_NAME = 'attendance_entries' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.worker_assignments wa
      WHERE wa.business_id = NEW.business_id
        AND wa.worker_id = NEW.worker_id
        AND wa.job_id = NEW.job_id
        AND wa.assigned_from <= NEW.work_date
        AND (wa.assigned_to IS NULL OR wa.assigned_to >= NEW.work_date)
    ) THEN
      RAISE EXCEPTION 'Worker is not assigned to this job on the selected date';
    END IF;
  END IF;

  SELECT email INTO actor_email FROM auth.users WHERE id = auth.uid();
  IF actor_email IS NOT NULL THEN
    NEW.updated_by_email := actor_email;
  END IF;

  IF NOT is_mgmt THEN
    NEW.verification_state := 'reported';
  ELSIF NEW.verification_state IS NULL THEN
    NEW.verification_state := 'verified';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS team_days_attendance_guard ON public.team_days;
CREATE TRIGGER team_days_attendance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.team_days
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_attendance_guard();

DROP TRIGGER IF EXISTS attendance_entries_guard ON public.attendance_entries;
CREATE TRIGGER attendance_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_entries
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_attendance_guard();

CREATE OR REPLACE FUNCTION public.worktrack_payroll_ready(p_business uuid, p_job uuid, p_week date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH eligible AS (
    SELECT DISTINCT w.id, w.worker_role_id, r.shares_crew_schedule
    FROM worker_assignments wa
    JOIN workers w ON w.id = wa.worker_id AND w.business_id = wa.business_id
    JOIN worker_roles r ON r.id = w.worker_role_id AND r.business_id = w.business_id
    WHERE wa.business_id = p_business
      AND wa.job_id = p_job
      AND wa.assigned_from <= p_week + 6
      AND (wa.assigned_to IS NULL OR wa.assigned_to >= p_week)
  ), days AS (
    SELECT
      w.id worker_id,
      d::date work_date,
      coalesce(a.day_status, CASE WHEN w.shares_crew_schedule THEN t.day_status END, 'unknown') state,
      coalesce(a.verification_state, CASE WHEN w.shares_crew_schedule THEN t.verification_state END, 'verified') vstate,
      coalesce(a.weekday_ot_hours, CASE WHEN w.shares_crew_schedule THEN t.weekday_ot_hours END, 0) ot,
      coalesce(a.saturday_hours, CASE WHEN w.shares_crew_schedule THEN t.saturday_hours END, 0) sat,
      coalesce(a.sunday_hours, CASE WHEN w.shares_crew_schedule THEN t.sunday_hours END, 0) sun,
      coalesce(a.public_holiday_hours, CASE WHEN w.shares_crew_schedule THEN t.public_holiday_hours END, 0) holiday,
      pr.id rule_id,
      pr.is_confirmed,
      pr.weekday_ot_hourly_cents,
      pr.saturday_rate_cents,
      pr.sunday_rate_cents,
      pr.public_holiday_rate_cents
    FROM eligible w
    CROSS JOIN generate_series(p_week::timestamp, (p_week + 6)::timestamp, interval '1 day') d
    LEFT JOIN attendance_entries a
      ON a.business_id = p_business AND a.job_id = p_job AND a.worker_id = w.id AND a.work_date = d::date
    LEFT JOIN team_days t
      ON t.business_id = p_business AND t.job_id = p_job AND t.work_date = d::date
    LEFT JOIN LATERAL (
      SELECT * FROM pay_rules p
      WHERE p.business_id = p_business
        AND p.worker_role_id = w.worker_role_id
        AND p.effective_from <= d::date
        AND (p.effective_to IS NULL OR p.effective_to >= d::date)
      ORDER BY p.effective_from DESC
      LIMIT 1
    ) pr ON true
  )
  SELECT
    public.has_business_role(p_business, ARRAY['admin','owner']::public.app_role[])
    AND EXISTS (SELECT 1 FROM eligible)
    AND NOT EXISTS (
      SELECT 1 FROM days
      WHERE state = 'unknown'
        OR vstate <> 'verified'
        OR is_confirmed = false
        OR (state IN ('worked','partial') AND rule_id IS NULL)
        OR (ot > 0 AND weekday_ot_hourly_cents IS NULL)
        OR (sat > 0 AND saturday_rate_cents IS NULL)
        OR (sun > 0 AND sunday_rate_cents IS NULL)
        OR (holiday > 0 AND public_holiday_rate_cents IS NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM attendance_entries a
      JOIN days d ON a.worker_id = d.worker_id AND a.work_date = d.work_date
      WHERE a.business_id = p_business
        AND a.job_id <> p_job
        AND a.day_status IN ('worked','partial')
        AND d.state IN ('worked','partial')
    );
$$;

CREATE OR REPLACE FUNCTION public.worktrack_verify_attendance_week(p_business uuid, p_job uuid, p_week date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  actor_email text;
  verified_team integer := 0;
  verified_entries integer := 0;
BEGIN
  IF NOT public.has_business_role(p_business, ARRAY['admin','owner']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only management can verify attendance';
  END IF;
  SELECT email INTO actor_email FROM auth.users WHERE id = auth.uid();

  UPDATE public.team_days
  SET verification_state = 'verified', updated_at = now()
  WHERE business_id = p_business
    AND job_id = p_job
    AND work_date BETWEEN p_week AND p_week + 6
    AND verification_state <> 'verified';
  GET DIAGNOSTICS verified_team = ROW_COUNT;

  UPDATE public.attendance_entries
  SET verification_state = 'verified', updated_at = now()
  WHERE business_id = p_business
    AND job_id = p_job
    AND work_date BETWEEN p_week AND p_week + 6
    AND verification_state <> 'verified';
  GET DIAGNOSTICS verified_entries = ROW_COUNT;

  INSERT INTO public.audit_events(business_id, actor_user_id, actor_email, entity_type, entity_id, action, reason)
  VALUES (
    p_business,
    auth.uid(),
    coalesce(actor_email, 'management'),
    'attendance_week',
    p_job,
    'attendance_verified',
    'Verified ' || verified_team || ' team day(s) and ' || verified_entries || ' worker entry(ies) for week ' || p_week::text
  );

  RETURN jsonb_build_object('verifiedTeamDays', verified_team, 'verifiedEntries', verified_entries);
END $$;
REVOKE ALL ON FUNCTION public.worktrack_verify_attendance_week(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worktrack_verify_attendance_week(uuid, uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.worktrack_capture_offline(p_business uuid,p_epoch bigint,p_key text,p_kind text,p_payload jsonb,p_base_revision integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; job uuid; actor_email text; oldrow jsonb; newrow jsonb; target uuid; base integer; side text; created uuid; table_name text; vstate text;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner','supervisor']::public.app_role[]) THEN RAISE EXCEPTION 'Active membership required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 IF (SELECT data_epoch FROM public.businesses WHERE id=p_business)<>p_epoch OR (SELECT maintenance_mode FROM public.businesses WHERE id=p_business) THEN RAISE EXCEPTION 'Obsolete offline draft or maintenance mode'; END IF;
 SELECT result_json INTO result FROM public.sync_idempotency_keys WHERE business_id=p_business AND idempotency_key=p_key AND processed_by=auth.uid();
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT email INTO actor_email FROM auth.users WHERE id=auth.uid();
 vstate:=CASE WHEN public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) THEN 'verified' ELSE 'reported' END;
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
  newrow:=p_payload||jsonb_build_object('id',target,'business_id',p_business,'revision',base+1,'verification_state',vstate,'updated_by_email',actor_email,'updated_at',now());
  IF p_kind='team' THEN
   INSERT INTO public.team_days SELECT (jsonb_populate_record(NULL::public.team_days,newrow)).* ON CONFLICT(business_id,job_id,work_date) DO UPDATE SET day_status=excluded.day_status,normal_hours=excluded.normal_hours,weekday_ot_hours=excluded.weekday_ot_hours,saturday_hours=excluded.saturday_hours,sunday_hours=excluded.sunday_hours,public_holiday_hours=excluded.public_holiday_hours,interruption_reason=excluded.interruption_reason,notes=excluded.notes,revision=excluded.revision,verification_state=excluded.verification_state,updated_by_email=excluded.updated_by_email,updated_at=excluded.updated_at;
  ELSE
   INSERT INTO public.attendance_entries SELECT (jsonb_populate_record(NULL::public.attendance_entries,newrow||jsonb_build_object('is_override',true))).* ON CONFLICT(business_id,worker_id,job_id,work_date) DO UPDATE SET day_status=excluded.day_status,normal_hours=excluded.normal_hours,weekday_ot_hours=excluded.weekday_ot_hours,saturday_hours=excluded.saturday_hours,sunday_hours=excluded.sunday_hours,public_holiday_hours=excluded.public_holiday_hours,is_override=true,override_reason=excluded.override_reason,revision=excluded.revision,verification_state=excluded.verification_state,updated_by_email=excluded.updated_by_email,updated_at=excluded.updated_at;
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