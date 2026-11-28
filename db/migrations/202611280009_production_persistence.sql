-- Forward-only upgrade; never replay migrations 0001-0008 on an existing VM.
ALTER TABLE public.businesses ADD COLUMN data_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE public.expenses ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.expenses ADD COLUMN idempotency_key text;
ALTER TABLE public.expenses ADD COLUMN receipt_attachment jsonb;
ALTER TABLE public.asset_checks ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX expenses_replay_unique ON public.expenses(business_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX checks_replay_unique ON public.asset_checks(business_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
-- A local attachment is not yet evidence: retain a review flag until finalized.
ALTER TABLE public.expenses DROP CONSTRAINT expenses_check;
ALTER TABLE public.expenses ADD CONSTRAINT expense_evidence_or_reason CHECK
 (receipt_object_key IS NOT NULL OR receipt_attachment IS NOT NULL OR length(trim(coalesce(missing_receipt_reason,''))) > 0);

-- All domain mutations from D/E are sent in a single transaction. This invoker
-- function retains RLS, uses a fixed table allowlist, and CAS-compares each row.
-- Dynamic columns must exist on the allowlisted table; no identifier is executable.
CREATE OR REPLACE FUNCTION public.worktrack_apply_changes(p_business uuid,p_epoch bigint,p_changes jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE ch jsonb; tab text; col text; cols text; vals text; updates text; previous jsonb; expected jsonb; row_id uuid; key_col text; current_epoch bigint;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner','supervisor']::public.app_role[]) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 -- Lock business row independently of UPDATE permission via advisory lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 SELECT data_epoch INTO current_epoch FROM public.businesses WHERE id=p_business;
 IF current_epoch IS DISTINCT FROM p_epoch THEN RAISE EXCEPTION 'Business reset: obsolete offline data rejected' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes)>1000 THEN RAISE EXCEPTION 'Invalid change batch'; END IF;
 FOR ch IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  tab:=ch->>'table';
  IF tab <> ALL(ARRAY['accounts','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','loans','loan_events','assets','asset_checks','defects','asset_services','weekly_reports','notifications','notification_preferences','customer_receipts','expense_settlements','forecast_assumptions']) THEN RAISE EXCEPTION 'Unsupported table'; END IF;
  IF (ch->'after'->>'business_id')::uuid IS DISTINCT FROM p_business THEN RAISE EXCEPTION 'Business mismatch'; END IF;
  key_col:=CASE WHEN tab='notification_preferences' THEN 'business_id' ELSE 'id' END;
  row_id:=(ch->'after'->>key_col)::uuid;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE %I=$1 AND business_id=$2',tab,key_col) INTO previous USING row_id,p_business;
  expected:=nullif(ch->'before','null'::jsonb);
  IF expected IS NOT NULL THEN EXECUTE format('SELECT to_jsonb(jsonb_populate_record(NULL::public.%I,$1))',tab) INTO expected USING expected; END IF;
  IF previous IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Concurrent change in %; refresh and review',tab USING ERRCODE='40001'; END IF;
  cols:=''; vals:=''; updates:='';
  FOR col IN SELECT jsonb_object_keys(ch->'after') LOOP
   IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=tab AND column_name=col) THEN RAISE EXCEPTION 'Invalid column % on %',col,tab; END IF;
   cols:=cols||CASE WHEN cols='' THEN '' ELSE ',' END||format('%I',col);
   vals:=vals||CASE WHEN vals='' THEN '' ELSE ',' END||format('r.%I',col);
   IF col NOT IN ('id','business_id') THEN updates:=updates||CASE WHEN updates='' THEN '' ELSE ',' END||format('%I=r.%I',col,col); END IF;
  END LOOP;
  IF previous IS NULL THEN
   EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r',tab,cols,vals,tab) USING ch->'after';
  ELSE
   EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I,$1) r WHERE t.%I=$2 AND t.business_id=$3',tab,updates,tab,key_col) USING ch->'after',row_id,p_business;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_apply_changes(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_apply_changes(uuid,bigint,jsonb) TO authenticated;

-- Composite tenant foreign keys; NOT VALID protects new writes and reports old
-- inconsistencies without deleting them. Validate on staging/VM before release.
CREATE UNIQUE INDEX assets_id_business_unique ON public.assets(id,business_id);
CREATE UNIQUE INDEX checks_id_business_unique ON public.asset_checks(id,business_id);
CREATE UNIQUE INDEX payroll_id_business_unique ON public.payroll_runs(id,business_id);
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('journal_entries','job_id','jobs'),('wage_payments','job_id','jobs'),('expenses','job_id','jobs'),('expense_requests','job_id','jobs'),
 ('expenses','account_id','accounts'),('expenses','expense_request_id','expense_requests'),('expenses','journal_entry_id','journal_entries'),
 ('transfers','from_account_id','accounts'),('transfers','to_account_id','accounts'),('transfers','journal_entry_id','journal_entries'),
 ('wage_allocations','payroll_run_id','payroll_runs'),('assets','assigned_job_id','jobs'),('asset_checks','asset_id','assets'),('asset_checks','job_id','jobs'),
 ('defects','asset_id','assets'),('defects','check_id','asset_checks'),('asset_services','asset_id','assets'),('weekly_reports','job_id','jobs')
 ) v(tab,col,parent) LOOP
 EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I,business_id) REFERENCES public.%I(id,business_id) ON DELETE RESTRICT NOT VALID',r.tab,r.tab||'_'||r.col||'_tenant_fk',r.col,r.parent);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.worktrack_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb; actor uuid:=auth.uid(); field text; is_admin boolean; actor_name text;
BEGIN
 IF actor IS NULL THEN RETURN NEW; END IF; -- trusted VM administration only
 is_admin:=public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[]);
 SELECT email INTO actor_name FROM auth.users WHERE id=actor;
 IF TG_OP='INSERT' THEN
  FOREACH field IN ARRAY ARRAY['created_by','recorded_by','requested_by','checked_by_user_id','reported_by_user_id'] LOOP
   IF n ? field THEN n:=jsonb_set(n,ARRAY[field],to_jsonb(actor::text)); END IF;
  END LOOP;
  IF n ? 'checked_by_name' THEN n:=jsonb_set(n,'{checked_by_name}',to_jsonb(coalesce(actor_name,''))); END IF;
  IF n ? 'reported_by_name' THEN n:=jsonb_set(n,'{reported_by_name}',to_jsonb(coalesce(actor_name,''))); END IF;
  IF TG_TABLE_NAME='expense_requests' AND (n->>'status' <> 'pending' OR n->>'reviewed_by' IS NOT NULL) THEN RAISE EXCEPTION 'Requests must start pending'; END IF;
  IF TG_TABLE_NAME='weekly_reports' AND (n->>'status' <> 'submitted' OR (n->>'current_revision')::int<>1) THEN RAISE EXCEPTION 'Reports must start submitted at revision 1'; END IF;
 ELSE
  o:=to_jsonb(OLD);
  FOREACH field IN ARRAY ARRAY['created_by','recorded_by','requested_by','checked_by_user_id','reported_by_user_id','created_at'] LOOP
   IF o ? field THEN n:=jsonb_set(n,ARRAY[field],o->field); END IF;
  END LOOP;
  IF TG_TABLE_NAME IN ('journal_entries','wage_payments') AND (n-ARRAY['evidence_status','verified_by']) IS DISTINCT FROM (o-ARRAY['evidence_status','verified_by']) THEN RAISE EXCEPTION 'Posted financial records are immutable; use reversal'; END IF;
  IF TG_TABLE_NAME='expenses' THEN
   IF (n-ARRAY['description','supplier_name','reference','missing_receipt_reason','revision','receipt_object_key','receipt_checksum_sha256','receipt_attachment','needs_review','paid_amount_cents','payment_status']) IS DISTINCT FROM (o-ARRAY['description','supplier_name','reference','missing_receipt_reason','revision','receipt_object_key','receipt_checksum_sha256','receipt_attachment','needs_review','paid_amount_cents','payment_status']) THEN RAISE EXCEPTION 'Expense amounts and accounts are immutable'; END IF;
   IF (n->>'revision')::int <> (o->>'revision')::int+1 THEN RAISE EXCEPTION 'Expense revision must advance exactly once'; END IF;
  END IF;
  IF TG_TABLE_NAME='expense_requests' AND n->>'status' IS DISTINCT FROM o->>'status' THEN
   IF NOT is_admin THEN RAISE EXCEPTION 'Only Admin can review requests'; END IF;
   n:=jsonb_set(n,'{reviewed_by}',to_jsonb(actor::text));
  END IF;
  IF TG_TABLE_NAME='defects' AND n->>'status'='resolved' AND o->>'status'='open' THEN
   IF NOT public.has_business_role(NEW.business_id,ARRAY['admin','owner']::public.app_role[]) OR length(trim(coalesce(n->>'resolution_notes','')))=0 THEN RAISE EXCEPTION 'Authorized resolution notes required'; END IF;
   n:=n||jsonb_build_object('resolved_by_user_id',actor,'resolved_by_name',actor_name,'resolved_at',now());
  END IF;
 END IF;
 IF TG_TABLE_NAME='weekly_reports' THEN
  IF n->>'status' IN ('approved','returned','draft') AND NOT is_admin THEN RAISE EXCEPTION 'Only Admin can review or amend reports'; END IF;
  IF TG_OP='UPDATE' THEN
   IF n->'revisions_json' @> o->'revisions_json' IS NOT TRUE THEN RAISE EXCEPTION 'Report revision history cannot be removed or changed'; END IF;
   IF o->>'status'='approved' THEN
    IF n->>'status'<>'draft' OR n->'locked_snapshot' IS DISTINCT FROM o->'locked_snapshot' OR n->'revisions_json' IS DISTINCT FROM o->'revisions_json' OR length(trim(coalesce(n->>'latest_comment','')))=0 THEN RAISE EXCEPTION 'Approved snapshot retained; open documented amendment'; END IF;
   END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME IN ('journal_entries','wage_payments','loan_events') AND n->>'evidence_status'='verified' AND NOT is_admin AND TG_TABLE_NAME<>'journal_entries' THEN RAISE EXCEPTION 'Only Admin verifies financial evidence'; END IF;
 NEW:=jsonb_populate_record(NEW,n); RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['journal_entries','wage_payments','expenses','expense_requests','asset_checks','defects','asset_services','weekly_reports','loan_events'] LOOP
 EXECUTE format('CREATE TRIGGER worktrack_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.worktrack_row_guard()',tab);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.worktrack_journal_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entry_id uuid; total_debit bigint; total_credit bigint; count_lines bigint;
BEGIN
 entry_id:=(CASE WHEN TG_TABLE_NAME='journal_entries' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'journal_entry_id' END)::uuid;
 SELECT sum(debit_cents),sum(credit_cents),count(*) INTO total_debit,total_credit,count_lines FROM public.journal_lines WHERE journal_entry_id=entry_id;
 IF count_lines<2 OR total_debit IS DISTINCT FROM total_credit THEN RAISE EXCEPTION 'Journal must balance with at least two lines'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced_header AFTER INSERT ON public.journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_journal_balanced();
CREATE CONSTRAINT TRIGGER journal_balanced_lines AFTER INSERT ON public.journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_journal_balanced();
CREATE OR REPLACE FUNCTION public.worktrack_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.journal_entries WHERE id=NEW.journal_entry_id AND xmin::text::bigint <> txid_current()) THEN RAISE EXCEPTION 'Cannot append to posted journal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER posted_line_guard BEFORE INSERT ON public.journal_lines FOR EACH ROW EXECUTE FUNCTION public.worktrack_line_guard();

CREATE OR REPLACE FUNCTION public.worktrack_allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE run_status text; earned bigint; allocated bigint; BEGIN
 PERFORM 1 FROM public.wage_payments WHERE id=NEW.wage_payment_id FOR UPDATE;
 IF NEW.payroll_run_id IS NOT NULL THEN
  SELECT status INTO run_status FROM public.payroll_runs WHERE id=NEW.payroll_run_id AND business_id=NEW.business_id;
  IF run_status <> 'approved' OR run_status IS NULL THEN RAISE EXCEPTION 'Allocate only to approved payroll'; END IF;
  SELECT net_pay_cents INTO earned FROM public.payroll_earnings WHERE payroll_run_id=NEW.payroll_run_id AND worker_id=NEW.worker_id AND business_id=NEW.business_id;
  SELECT coalesce(sum(amount_cents),0) INTO allocated FROM public.wage_allocations WHERE payroll_run_id=NEW.payroll_run_id AND worker_id=NEW.worker_id;
  IF earned IS NULL OR allocated+NEW.amount_cents>earned THEN RAISE EXCEPTION 'Allocation exceeds worker earnings'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER allocation_authority BEFORE INSERT ON public.wage_allocations FOR EACH ROW EXECUTE FUNCTION public.worktrack_allocation_guard();

-- Operational supervisor checks: RLS reaches the actual assigned asset/job.
DROP POLICY assets_select_member ON public.assets;
CREATE POLICY assets_select_scoped ON public.assets FOR SELECT TO authenticated USING (public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]) OR public.is_assigned_to_job(business_id,assigned_job_id));
DROP POLICY asset_checks_select_member ON public.asset_checks;
DROP POLICY asset_checks_insert_member ON public.asset_checks;
CREATE POLICY checks_select_scoped ON public.asset_checks FOR SELECT TO authenticated USING (public.is_assigned_to_job(business_id,job_id) OR public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY checks_insert_scoped ON public.asset_checks FOR INSERT TO authenticated WITH CHECK (public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]) OR (public.is_assigned_to_job(business_id,job_id) AND EXISTS(SELECT 1 FROM public.assets a WHERE a.id=asset_id AND a.business_id=asset_checks.business_id AND a.assigned_job_id=asset_checks.job_id)));
DROP POLICY defects_select_member ON public.defects;
DROP POLICY defects_insert_member ON public.defects;
CREATE POLICY defects_select_scoped ON public.defects FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.assets a WHERE a.id=asset_id AND a.business_id=defects.business_id));
CREATE POLICY defects_insert_scoped ON public.defects FOR INSERT TO authenticated WITH CHECK (EXISTS(SELECT 1 FROM public.asset_checks c WHERE c.id=check_id AND c.asset_id=defects.asset_id AND c.business_id=defects.business_id));
DROP POLICY notifications_member_access ON public.notifications;
CREATE POLICY notifications_management ON public.notifications FOR ALL TO authenticated USING (public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[])) WITH CHECK (public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
-- Expense descriptive edits are versioned, amounts locked by trigger.
CREATE POLICY expenses_owner_descriptive_update ON public.expenses FOR UPDATE TO authenticated USING (public.has_business_role(business_id,ARRAY['owner']::public.app_role[])) WITH CHECK (public.has_business_role(business_id,ARRAY['owner']::public.app_role[]));

-- Critical checks immediately change the server asset state, including supervisor
-- capture; clearing is possible only after all critical defects are resolved.
CREATE OR REPLACE FUNCTION public.worktrack_safety_state() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='asset_checks' THEN
  IF EXISTS(SELECT 1 FROM jsonb_each_text(NEW.items) x WHERE x.key IN ('oil','coolant','leaks','tyres','brakes_lights','warning_lights') AND x.value<>'ok') THEN
   UPDATE public.assets SET status='unavailable_defect',updated_at=now() WHERE id=NEW.asset_id AND business_id=NEW.business_id;
  END IF;
 ELSE
  IF NEW.status='resolved' AND NOT EXISTS(SELECT 1 FROM public.defects d WHERE d.asset_id=NEW.asset_id AND d.status='open' AND d.severity='critical') THEN
   UPDATE public.assets SET status='available',updated_at=now() WHERE id=NEW.asset_id AND business_id=NEW.business_id AND status='unavailable_defect';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safety_check_state AFTER INSERT ON public.asset_checks FOR EACH ROW EXECUTE FUNCTION public.worktrack_safety_state();
CREATE TRIGGER safety_resolution_state AFTER UPDATE ON public.defects FOR EACH ROW EXECUTE FUNCTION public.worktrack_safety_state();
REVOKE DELETE ON public.assets,public.weekly_reports,public.notifications FROM authenticated;

-- Explicit chart-of-accounts setup: zero balances, never fake transactions.
CREATE OR REPLACE FUNCTION public.worktrack_setup_accounts(p_business uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Admin required'; END IF;
 INSERT INTO public.accounts(business_id,code,name,account_type,is_cash_account,is_restricted,opening_balance_verified)
 SELECT p_business,code,name,typ::public.ledger_account_type,cash,restricted,true FROM (VALUES
 ('1010','Business bank','bank',true,false),('1020','Field cash','cash',true,false),('1030','Restricted funding','restricted_funding',true,true),
 ('2100','Wages payable','wages_payable',false,false),('2200','Loan liability','loan_liability',false,false),('3000','Owner equity','owner_equity',false,false),
 ('4000','Customer receipts','customer_revenue',false,false),('4100','Restricted grants','restricted_grant_income',false,false),('5000','Operating expenses','operating_expenses',false,false),('1500','Capital expenditure','capital_expenditure',false,false)
 ) x(code,name,typ,cash,restricted) ON CONFLICT(business_id,code) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_setup_accounts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_setup_accounts(uuid) TO authenticated;
