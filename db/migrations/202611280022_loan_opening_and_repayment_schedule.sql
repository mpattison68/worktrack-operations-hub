-- WorkTrack Forward Migration 0022:
-- Manual opening loan liability metadata, agreed repayment schedules,
-- opening balance immutability after posting, and duplicate payment guards.

ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS effective_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS reference text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';

-- Prevent silent retroactive amendment of opening principal once verified or after events are posted.
CREATE OR REPLACE FUNCTION public.worktrack_loan_opening_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW; -- trusted VM administration only
  END IF;
  IF NEW.opening_principal_cents IS DISTINCT FROM OLD.opening_principal_cents THEN
    IF OLD.opening_principal_verified OR EXISTS (
      SELECT 1 FROM public.loan_events e WHERE e.loan_id = OLD.id AND e.business_id = OLD.business_id
    ) THEN
      RAISE EXCEPTION 'Opening loan principal cannot be amended after verification or posted loan events';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS loan_opening_guard ON public.loans;
CREATE TRIGGER loan_opening_guard
  BEFORE UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_loan_opening_guard();

-- Prevent duplicate loan payments/advances with identical non-empty reference, date, type, and amount.
CREATE UNIQUE INDEX IF NOT EXISTS loan_events_no_duplicate_ref
  ON public.loan_events (loan_id, event_type, event_date, amount_cents, lower(trim(reference)))
  WHERE length(trim(reference)) > 0;

-- Prevent duplicate customer receipts with identical non-empty reference, date, and amount on a milestone.
CREATE UNIQUE INDEX IF NOT EXISTS customer_receipts_no_duplicate_ref
  ON public.customer_receipts (milestone_id, receipt_date, amount_cents, lower(trim(reference)))
  WHERE length(trim(reference)) > 0;

-- Agreed optional repayment schedule installments (informational & cash-flow forecast only; never operating expenses).
CREATE TABLE IF NOT EXISTS public.loan_repayment_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  loan_id uuid NOT NULL,
  expected_date date NOT NULL,
  expected_amount_cents bigint NOT NULL CHECK (expected_amount_cents > 0),
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (loan_id, business_id) REFERENCES public.loans(id, business_id) ON DELETE RESTRICT
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.loan_repayment_schedules TO authenticated;
GRANT ALL ON public.loan_repayment_schedules TO service_role;
ALTER TABLE public.loan_repayment_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY loan_repayment_schedules_read ON public.loan_repayment_schedules
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE POLICY loan_repayment_schedules_write_admin ON public.loan_repayment_schedules
  FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE TRIGGER epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.loan_repayment_schedules
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_epoch_guard();
CREATE TRIGGER row_guard BEFORE INSERT OR UPDATE ON public.loan_repayment_schedules
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_row_guard();

-- Extend allowlisted tables in worktrack_apply_changes and worktrack_read_bundle.
CREATE OR REPLACE FUNCTION public.worktrack_apply_changes(p_business uuid, p_epoch bigint, p_changes jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE ch jsonb; tab text; col text; cols text; vals text; updates text; previous jsonb; expected jsonb; row_id uuid; key_col text; current_epoch bigint;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner','supervisor']::public.app_role[]) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 SELECT data_epoch INTO current_epoch FROM public.businesses WHERE id=p_business;
 IF current_epoch IS DISTINCT FROM p_epoch THEN RAISE EXCEPTION 'Business reset: obsolete offline data rejected' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes)>1000 THEN RAISE EXCEPTION 'Invalid change batch'; END IF;
 FOR ch IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  tab:=ch->>'table';
  IF tab <> ALL(ARRAY['accounts','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','loans','loan_events','loan_repayment_schedules','assets','asset_checks','defects','asset_services','weekly_reports','notifications','notification_preferences','customer_receipts','expense_settlements','forecast_assumptions','funding_receipts']) THEN RAISE EXCEPTION 'Unsupported table'; END IF;
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
  IF tab<>ALL(ARRAY['accounts','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','loans','loan_events','loan_repayment_schedules','customer_receipts','expense_settlements','forecast_assumptions','funding_receipts','assets','asset_checks','defects','asset_services','weekly_reports','notifications','notification_preferences','asset_private','notification_receipts']) THEN RAISE EXCEPTION 'Unsupported read table'; END IF;
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) FROM public.%I t WHERE business_id=$1',tab) INTO values_json USING p_business;
  tables_json:=tables_json||jsonb_build_object(tab,values_json);
 END LOOP;
 RETURN jsonb_build_object('epoch',epoch,'tables',tables_json);
END $$;
REVOKE ALL ON FUNCTION public.worktrack_read_bundle(uuid,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_read_bundle(uuid,text[]) TO authenticated;