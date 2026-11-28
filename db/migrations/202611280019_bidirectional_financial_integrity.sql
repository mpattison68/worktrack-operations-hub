CREATE TABLE public.funding_receipts (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES public.businesses(id),receipt_date date NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),account_id uuid NOT NULL,journal_entry_id uuid NOT NULL UNIQUE,reference text NOT NULL DEFAULT '',recorded_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,business_id) REFERENCES public.accounts(id,business_id),FOREIGN KEY(journal_entry_id,business_id) REFERENCES public.journal_entries(id,business_id)
);
GRANT SELECT,INSERT ON public.funding_receipts TO authenticated;
GRANT ALL ON public.funding_receipts TO service_role;
ALTER TABLE public.funding_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY funding_read ON public.funding_receipts FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY funding_insert ON public.funding_receipts FOR INSERT TO authenticated WITH CHECK(public.has_business_role(business_id,ARRAY['admin']::public.app_role[]));
CREATE TRIGGER epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.funding_receipts FOR EACH ROW EXECUTE FUNCTION public.worktrack_epoch_guard();
CREATE TRIGGER actor_guard BEFORE INSERT ON public.funding_receipts FOR EACH ROW EXECUTE FUNCTION public.worktrack_row_guard();
CREATE UNIQUE INDEX loan_event_one_posting ON public.loan_events(journal_entry_id);
CREATE UNIQUE INDEX expense_one_posting ON public.expenses(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX transfer_one_posting ON public.transfers(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX wage_payment_one_posting ON public.wage_payments(journal_entry_id);

CREATE OR REPLACE FUNCTION public.worktrack_financial_source_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.journal_entries; posting uuid; expected bigint; debit_account uuid; credit_account uuid; credit_type public.ledger_account_type; observed bigint; source_id uuid; t public.transfers; ev public.loan_events;
BEGIN
 posting:=CASE WHEN TG_TABLE_NAME='journal_entries' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'journal_entry_id')::uuid END;
 IF posting IS NULL THEN
  IF TG_TABLE_NAME='expenses' AND NEW.paid_amount_cents=0 THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='transfers' AND NEW.status<>'matched' THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Financial source requires its posting';
 END IF;
 SELECT * INTO j FROM journal_entries WHERE id=posting;
 IF j.id IS NULL OR j.business_id<>NEW.business_id THEN RAISE EXCEPTION 'Missing same-business journal'; END IF;
 source_id:=j.source_id;
 CASE j.source_type
 WHEN 'expense' THEN
  SELECT initial_paid_amount_cents,account_id INTO expected,credit_account FROM expenses WHERE id=source_id AND business_id=j.business_id AND journal_entry_id=j.id;
 WHEN 'expense_settlement' THEN
  SELECT amount_cents,account_id INTO expected,credit_account FROM expense_settlements WHERE id=source_id AND business_id=j.business_id AND journal_entry_id=j.id;
 WHEN 'wage_payment' THEN
  SELECT total_amount_cents,account_id INTO expected,credit_account FROM wage_payments WHERE id=source_id AND business_id=j.business_id AND journal_entry_id=j.id;
 WHEN 'customer_receipt' THEN
  SELECT amount_cents,account_id INTO expected,debit_account FROM customer_receipts WHERE id=source_id AND business_id=j.business_id AND journal_entry_id=j.id;credit_type:='customer_revenue';
 WHEN 'grant_receipt' THEN
  SELECT amount_cents,account_id INTO expected,debit_account FROM funding_receipts WHERE id=source_id AND business_id=j.business_id AND journal_entry_id=j.id;credit_type:='restricted_grant_income';
 WHEN 'loan_advance','loan_repayment' THEN
  SELECT * INTO ev FROM loan_events WHERE id=source_id AND business_id=j.business_id AND journal_entry_id=j.id AND event_type=CASE WHEN j.source_type='loan_advance' THEN 'advance' ELSE 'repayment' END;
  expected:=ev.amount_cents;
  IF j.source_type='loan_advance' THEN debit_account:=ev.account_id;credit_type:='loan_liability';ELSE credit_account:=ev.account_id;END IF;
 WHEN 'transfer' THEN
  SELECT * INTO t FROM transfers WHERE id=source_id AND business_id=j.business_id AND journal_entry_id=j.id AND status='matched';
  expected:=t.amount_cents;debit_account:=t.to_account_id;
  IF t.transfer_kind='internal_transfer' THEN credit_account:=t.from_account_id;
  ELSIF t.transfer_kind='lender_advance' THEN credit_type:='loan_liability';
   IF NOT EXISTS(SELECT 1 FROM loan_events e WHERE e.business_id=j.business_id AND e.journal_entry_id=j.id AND e.event_type='advance' AND e.amount_cents=t.amount_cents AND e.account_id=t.to_account_id) THEN RAISE EXCEPTION 'Lender transfer needs one matching loan event';END IF;
  ELSIF t.transfer_kind='restricted_grant' THEN credit_type:='restricted_grant_income';ELSE credit_type:='owner_equity';END IF;
 ELSE RAISE EXCEPTION 'Unsupported financial posting source';
 END CASE;
 IF TG_TABLE_NAME<>'journal_entries' THEN
  IF TG_TABLE_NAME='loan_events' AND j.source_type='transfer' THEN
   IF t.transfer_kind<>'lender_advance' OR NEW.event_type<>'advance' OR NEW.amount_cents<>expected OR NEW.account_id<>debit_account THEN RAISE EXCEPTION 'Loan event must match transfer';END IF;
  ELSIF TG_TABLE_NAME<>(CASE j.source_type WHEN 'expense' THEN 'expenses' WHEN 'expense_settlement' THEN 'expense_settlements' WHEN 'wage_payment' THEN 'wage_payments' WHEN 'customer_receipt' THEN 'customer_receipts' WHEN 'grant_receipt' THEN 'funding_receipts' WHEN 'loan_advance' THEN 'loan_events' WHEN 'loan_repayment' THEN 'loan_events' WHEN 'transfer' THEN 'transfers' END) OR NEW.id<>source_id THEN RAISE EXCEPTION 'Source must point back to its own posting';END IF;
 END IF;
 SELECT sum(debit_cents) INTO observed FROM journal_lines WHERE journal_entry_id=j.id;
 IF expected IS NULL OR observed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Posting must match its authoritative source amount'; END IF;
 IF debit_account IS NOT NULL AND expected<>(SELECT coalesce(sum(debit_cents),0) FROM journal_lines WHERE journal_entry_id=j.id AND account_id=debit_account) THEN RAISE EXCEPTION 'Posting debit account mismatch';END IF;
 IF credit_account IS NOT NULL AND expected<>(SELECT coalesce(sum(credit_cents),0) FROM journal_lines WHERE journal_entry_id=j.id AND account_id=credit_account) THEN RAISE EXCEPTION 'Posting credit account mismatch';END IF;
 IF credit_type IS NOT NULL AND expected<>(SELECT coalesce(sum(l.credit_cents),0) FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=j.id AND a.account_type=credit_type) THEN RAISE EXCEPTION 'Posting credit purpose mismatch';END IF;
 IF j.source_type='wage_payment' AND expected<>(SELECT coalesce(sum(amount_cents),0) FROM wage_allocations WHERE wage_payment_id=source_id) THEN RAISE EXCEPTION 'Wage allocations must equal payment';END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['expenses','expense_settlements','wage_payments','customer_receipts','funding_receipts','loan_events','transfers'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER source_posting_integrity AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_financial_source_check()',tab);
 END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER milestone_history_total AFTER INSERT OR UPDATE ON public.payment_milestones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_receipt_totals();
CREATE OR REPLACE FUNCTION public.worktrack_matched_transfer_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF auth.uid() IS NOT NULL AND OLD.status='matched' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Matched transfer is immutable';END IF;RETURN NEW;
END $$;
CREATE TRIGGER matched_transfer_lock BEFORE UPDATE ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.worktrack_matched_transfer_lock();
CREATE OR REPLACE FUNCTION public.worktrack_allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE earned bigint; allocated bigint; BEGIN
 IF NEW.payroll_run_id IS NOT NULL THEN
  SELECT net_pay_cents INTO earned FROM payroll_earnings WHERE payroll_run_id=NEW.payroll_run_id AND worker_id=NEW.worker_id AND business_id=NEW.business_id FOR UPDATE;
  IF earned IS NULL OR NOT EXISTS(SELECT 1 FROM payroll_runs WHERE id=NEW.payroll_run_id AND business_id=NEW.business_id AND status='approved') THEN RAISE EXCEPTION 'Approved worker earnings required';END IF;
  SELECT coalesce(sum(amount_cents),0) INTO allocated FROM wage_allocations WHERE payroll_run_id=NEW.payroll_run_id AND worker_id=NEW.worker_id;
  IF allocated+NEW.amount_cents>earned THEN RAISE EXCEPTION 'Allocation exceeds worker earnings';END IF;
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.worktrack_safety_state() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_TABLE_NAME='asset_checks' THEN
  IF NEW.stop_use_triggered THEN UPDATE assets SET status='unavailable_defect',updated_at=now() WHERE id=NEW.asset_id AND business_id=NEW.business_id;END IF;
 ELSE
  IF NEW.status='resolved' AND NOT EXISTS(SELECT 1 FROM defects WHERE asset_id=NEW.asset_id AND status='open' AND severity='critical') THEN UPDATE assets SET status='available',updated_at=now() WHERE id=NEW.asset_id AND business_id=NEW.business_id AND status='unavailable_defect';END IF;
 END IF;RETURN NEW;
END $$;

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
  IF tab <> ALL(ARRAY['accounts','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','loans','loan_events','assets','asset_checks','defects','asset_services','weekly_reports','notifications','notification_preferences','customer_receipts','expense_settlements','forecast_assumptions','funding_receipts']) THEN RAISE EXCEPTION 'Unsupported table'; END IF;
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

CREATE OR REPLACE FUNCTION public.worktrack_read_bundle(p_business uuid,p_tables text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE tab text; values_json jsonb; tables_json jsonb:='{}';epoch bigint;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner','supervisor']::public.app_role[]) THEN RAISE EXCEPTION 'Active membership required'; END IF;
 SELECT data_epoch INTO epoch FROM public.businesses WHERE id=p_business;
 FOREACH tab IN ARRAY p_tables LOOP
  IF tab<>ALL(ARRAY['accounts','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','loans','loan_events','customer_receipts','expense_settlements','forecast_assumptions','funding_receipts','assets','asset_checks','defects','asset_services','weekly_reports','notifications','notification_preferences','asset_private','notification_receipts']) THEN RAISE EXCEPTION 'Unsupported read table'; END IF;
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) FROM public.%I t WHERE business_id=$1',tab) INTO values_json USING p_business;
  tables_json:=tables_json||jsonb_build_object(tab,values_json);
 END LOOP;
 RETURN jsonb_build_object('epoch',epoch,'tables',tables_json);
END $$;
REVOKE ALL ON FUNCTION public.worktrack_read_bundle(uuid,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_read_bundle(uuid,text[]) TO authenticated;

-- Explicit JSON operands avoid operator-precedence errors in review updates.
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
  IF TG_TABLE_NAME='expense_requests' AND ((n->>'status') <> 'pending' OR (n->>'reviewed_by') IS NOT NULL) THEN RAISE EXCEPTION 'Requests must start pending'; END IF;
  IF TG_TABLE_NAME='weekly_reports' AND ((n->>'status') <> 'submitted' OR ((n->>'current_revision'))::int<>1) THEN RAISE EXCEPTION 'Reports must start submitted at revision 1'; END IF;
 ELSE
  o:=to_jsonb(OLD);
  FOREACH field IN ARRAY ARRAY['created_by','recorded_by','requested_by','checked_by_user_id','reported_by_user_id','created_at'] LOOP
   IF o ? field THEN n:=jsonb_set(n,ARRAY[field],o->field); END IF;
  END LOOP;
  IF TG_TABLE_NAME IN ('journal_entries','wage_payments') AND (n-ARRAY['evidence_status','verified_by']) IS DISTINCT FROM (o-ARRAY['evidence_status','verified_by']) THEN RAISE EXCEPTION 'Posted financial records are immutable; use reversal'; END IF;
  IF TG_TABLE_NAME='expenses' THEN
   IF (n-ARRAY['description','supplier_name','reference','missing_receipt_reason','revision','receipt_object_key','receipt_checksum_sha256','receipt_attachment','needs_review','paid_amount_cents','payment_status']) IS DISTINCT FROM (o-ARRAY['description','supplier_name','reference','missing_receipt_reason','revision','receipt_object_key','receipt_checksum_sha256','receipt_attachment','needs_review','paid_amount_cents','payment_status']) THEN RAISE EXCEPTION 'Expense amounts and accounts are immutable'; END IF;
   IF ((n->>'revision'))::int <> ((o->>'revision'))::int+1 THEN RAISE EXCEPTION 'Expense revision must advance exactly once'; END IF;
  END IF;
  IF TG_TABLE_NAME='expense_requests' AND (n->>'status') IS DISTINCT FROM (o->>'status') THEN
   IF NOT is_admin THEN RAISE EXCEPTION 'Only Admin can review requests'; END IF;
   n:=jsonb_set(n,'{reviewed_by}',to_jsonb(actor::text));
  END IF;
  IF TG_TABLE_NAME='defects' AND (n->>'status')='resolved' AND (o->>'status')='open' THEN
   IF NOT public.has_business_role(NEW.business_id,ARRAY['admin','owner']::public.app_role[]) OR length(trim(coalesce((n->>'resolution_notes'),'')))=0 THEN RAISE EXCEPTION 'Authorized resolution notes required'; END IF;
   n:=n||jsonb_build_object('resolved_by_user_id',actor,'resolved_by_name',actor_name,'resolved_at',now());
  END IF;
 END IF;
 IF TG_TABLE_NAME='weekly_reports' THEN
  IF (n->>'status') IN ('approved','returned','draft') AND NOT is_admin THEN RAISE EXCEPTION 'Only Admin can review or amend reports'; END IF;
  IF TG_OP='UPDATE' THEN
   IF (n->'revisions_json') @> (o->'revisions_json') IS NOT TRUE THEN RAISE EXCEPTION 'Report revision history cannot be removed or changed'; END IF;
   IF (o->>'status')='approved' THEN
    IF (n->>'status')<>'draft' OR (n->'locked_snapshot') IS DISTINCT FROM (o->'locked_snapshot') OR (n->'revisions_json') IS DISTINCT FROM (o->'revisions_json') OR length(trim(coalesce((n->>'latest_comment'),'')))=0 THEN RAISE EXCEPTION 'Approved snapshot retained; open documented amendment'; END IF;
   END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME IN ('journal_entries','wage_payments','loan_events') AND (n->>'evidence_status')='verified' AND NOT is_admin AND TG_TABLE_NAME<>'journal_entries' THEN RAISE EXCEPTION 'Only Admin verifies financial evidence'; END IF;
 NEW:=jsonb_populate_record(NEW,n); RETURN NEW;
END $$;
