-- WorkTrack Forward Migration 0023:
-- General financial transaction reversals, balanced non-cash opening loan entries,
-- Owner loan repayment & customer receipt workflows with Admin verification,
-- scheduled instalment allocation, and offline interruption / exception-reset capture.

-- 1. Financial reversals audit table (preserves original records, prevents duplicate reversals)
CREATE TABLE IF NOT EXISTS public.financial_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (
    target_type IN (
      'customer_receipt',
      'wage_payment',
      'expense',
      'expense_settlement',
      'loan_advance',
      'loan_repayment',
      'transfer'
    )
  ),
  target_id uuid NOT NULL,
  original_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  reversed_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, target_type, target_id)
);

GRANT SELECT, INSERT ON public.financial_reversals TO authenticated;
GRANT ALL ON public.financial_reversals TO service_role;
ALTER TABLE public.financial_reversals ENABLE ROW LEVEL SECURITY;

CREATE POLICY financial_reversals_read ON public.financial_reversals
  FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE POLICY financial_reversals_insert_admin ON public.financial_reversals
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_reversal
  ON public.journal_entries (reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

-- 2. Scheduled instalment allocation link on loan_events & evidence status on customer_receipts
CREATE UNIQUE INDEX IF NOT EXISTS loan_repayment_schedules_id_business_unique
  ON public.loan_repayment_schedules (id, business_id);

ALTER TABLE public.loan_events
  ADD COLUMN IF NOT EXISTS schedule_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loan_events_schedule_fk'
  ) THEN
    ALTER TABLE public.loan_events
      ADD CONSTRAINT loan_events_schedule_fk
      FOREIGN KEY (schedule_id, business_id)
      REFERENCES public.loan_repayment_schedules(id, business_id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.customer_receipts
  ADD COLUMN IF NOT EXISTS evidence_status public.evidence_status NOT NULL DEFAULT 'verified',
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES auth.users(id);

GRANT UPDATE ON public.customer_receipts TO authenticated;
GRANT UPDATE ON public.loan_events TO authenticated;

-- 3. Owner workflow RLS: Owner can record customer receipts (reported) & unrestricted loan repayments (reported)
DROP POLICY IF EXISTS receipts_post ON public.customer_receipts;
CREATE POLICY receipts_post_mgmt ON public.customer_receipts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin']::public.app_role[])
    OR (
      public.has_business_role(business_id, ARRAY['owner']::public.app_role[])
      AND evidence_status = 'reported'
      AND verified_by IS NULL
    )
  );

CREATE POLICY receipts_verify_admin ON public.customer_receipts
  FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY milestones_owner_receipt_update ON public.payment_milestones
  FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['owner']::public.app_role[]));

DROP POLICY IF EXISTS loan_events_insert_admin ON public.loan_events;
CREATE POLICY loan_events_insert_admin ON public.loan_events
  FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE POLICY loan_events_insert_owner_repayment ON public.loan_events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['owner']::public.app_role[])
    AND event_type = 'repayment'
    AND evidence_status = 'reported'
    AND used_restricted_funding = false
    AND restricted_eligibility_approved = false
  );

CREATE POLICY loan_events_verify_admin ON public.loan_events
  FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- 4. Update row guard for financial_reversals, customer_receipts, loan_events, and payment_milestones
CREATE OR REPLACE FUNCTION public.worktrack_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); o jsonb; actor uuid := auth.uid(); field text; is_admin boolean; actor_name text;
BEGIN
  IF actor IS NULL THEN RETURN NEW; END IF; -- trusted VM administration only
  is_admin := public.has_business_role(NEW.business_id, ARRAY['admin']::public.app_role[]);
  SELECT email INTO actor_name FROM auth.users WHERE id = actor;

  IF TG_OP = 'INSERT' THEN
    FOREACH field IN ARRAY ARRAY['created_by','recorded_by','requested_by','checked_by_user_id','reported_by_user_id','reversed_by'] LOOP
      IF n ? field THEN n := jsonb_set(n, ARRAY[field], to_jsonb(actor::text)); END IF;
    END LOOP;
    IF n ? 'checked_by_name' THEN n := jsonb_set(n, '{checked_by_name}', to_jsonb(coalesce(actor_name,''))); END IF;
    IF n ? 'reported_by_name' THEN n := jsonb_set(n, '{reported_by_name}', to_jsonb(coalesce(actor_name,''))); END IF;
    IF TG_TABLE_NAME = 'expense_requests' AND ((n->>'status') <> 'pending' OR (n->>'reviewed_by') IS NOT NULL) THEN
      RAISE EXCEPTION 'Requests must start pending';
    END IF;
    IF TG_TABLE_NAME = 'weekly_reports' AND ((n->>'status') <> 'submitted' OR ((n->>'current_revision'))::int <> 1) THEN
      RAISE EXCEPTION 'Reports must start submitted at revision 1';
    END IF;
  ELSE
    o := to_jsonb(OLD);
    FOREACH field IN ARRAY ARRAY['created_by','recorded_by','requested_by','checked_by_user_id','reported_by_user_id','reversed_by','created_at'] LOOP
      IF o ? field THEN n := jsonb_set(n, ARRAY[field], o->field); END IF;
    END LOOP;
    IF TG_TABLE_NAME IN ('journal_entries','wage_payments','customer_receipts','loan_events')
       AND (n - ARRAY['evidence_status','verified_by']) IS DISTINCT FROM (o - ARRAY['evidence_status','verified_by']) THEN
      RAISE EXCEPTION 'Posted financial records are immutable; use reversal';
    END IF;
    IF TG_TABLE_NAME = 'payment_milestones' AND NOT is_admin THEN
      IF (n - ARRAY['received_amount_cents','received_date','status','account_id','reference','journal_entry_id'])
         IS DISTINCT FROM (o - ARRAY['received_amount_cents','received_date','status','account_id','reference','journal_entry_id']) THEN
        RAISE EXCEPTION 'Only Admin can amend customer milestone terms or expected amounts';
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'expenses' THEN
      IF (n - ARRAY['description','supplier_name','reference','missing_receipt_reason','revision','receipt_object_key','receipt_checksum_sha256','receipt_attachment','needs_review','paid_amount_cents','payment_status'])
         IS DISTINCT FROM (o - ARRAY['description','supplier_name','reference','missing_receipt_reason','revision','receipt_object_key','receipt_checksum_sha256','receipt_attachment','needs_review','paid_amount_cents','payment_status']) THEN
        RAISE EXCEPTION 'Expense amounts and accounts are immutable';
      END IF;
      IF ((n->>'revision'))::int <> ((o->>'revision'))::int + 1 THEN
        RAISE EXCEPTION 'Expense revision must advance exactly once';
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'expense_requests' AND (n->>'status') IS DISTINCT FROM (o->>'status') THEN
      IF NOT is_admin THEN RAISE EXCEPTION 'Only Admin can review requests'; END IF;
      n := jsonb_set(n, '{reviewed_by}', to_jsonb(actor::text));
    END IF;
    IF TG_TABLE_NAME = 'defects' AND (n->>'status') = 'resolved' AND (o->>'status') = 'open' THEN
      IF NOT public.has_business_role(NEW.business_id, ARRAY['admin','owner']::public.app_role[])
         OR length(trim(coalesce((n->>'resolution_notes'),''))) = 0 THEN
        RAISE EXCEPTION 'Authorized resolution notes required';
      END IF;
      n := n || jsonb_build_object('resolved_by_user_id', actor, 'resolved_by_name', actor_name, 'resolved_at', now());
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'weekly_reports' THEN
    IF (n->>'status') IN ('approved','returned','draft') AND NOT is_admin THEN
      RAISE EXCEPTION 'Only Admin can review or amend reports';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF (n->'revisions_json') @> (o->'revisions_json') IS NOT TRUE THEN
        RAISE EXCEPTION 'Report revision history cannot be removed or changed';
      END IF;
      IF (o->>'status') = 'approved' THEN
        IF (n->>'status') <> 'draft'
           OR (n->'locked_snapshot') IS DISTINCT FROM (o->'locked_snapshot')
           OR (n->'revisions_json') IS DISTINCT FROM (o->'revisions_json')
           OR length(trim(coalesce((n->>'latest_comment'),''))) = 0 THEN
          RAISE EXCEPTION 'Approved snapshot retained; open documented amendment';
        END IF;
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('wage_payments','loan_events','customer_receipts') AND (n->>'evidence_status') = 'verified' AND NOT is_admin THEN
    RAISE EXCEPTION 'Only Admin verifies financial evidence';
  END IF;

  RETURN jsonb_populate_record(NEW, n);
END $$;

DROP TRIGGER IF EXISTS epoch_guard ON public.financial_reversals;
CREATE TRIGGER epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.financial_reversals
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_epoch_guard();
DROP TRIGGER IF EXISTS row_guard ON public.financial_reversals;
CREATE TRIGGER row_guard BEFORE INSERT OR UPDATE ON public.financial_reversals
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_row_guard();
DROP TRIGGER IF EXISTS row_guard ON public.payment_milestones;
CREATE TRIGGER row_guard BEFORE INSERT OR UPDATE ON public.payment_milestones
  FOR EACH ROW EXECUTE FUNCTION public.worktrack_row_guard();

-- 5. Update financial source check to support balanced non-cash loan_opening and verified reversals
CREATE OR REPLACE FUNCTION public.worktrack_financial_source_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.journal_entries;
  orig public.journal_entries;
  posting uuid;
  expected bigint;
  debit_account uuid;
  credit_account uuid;
  debit_type public.ledger_account_type;
  credit_type public.ledger_account_type;
  observed bigint;
  source_id uuid;
  t public.transfers;
  ev public.loan_events;
  ln public.loans;
  mismatch_count integer;
BEGIN
  posting := CASE WHEN TG_TABLE_NAME = 'journal_entries' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'journal_entry_id')::uuid END;
  IF posting IS NULL THEN
    IF TG_TABLE_NAME = 'expenses' AND NEW.paid_amount_cents = 0 THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'transfers' AND NEW.status <> 'matched' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Financial source requires its posting';
  END IF;

  SELECT * INTO j FROM public.journal_entries WHERE id = posting;
  IF j.id IS NULL OR j.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'Missing same-business journal';
  END IF;
  source_id := j.source_id;

  IF j.source_type = 'reversal' THEN
    IF auth.uid() IS NOT NULL AND NOT public.has_business_role(j.business_id, ARRAY['admin']::public.app_role[]) THEN
      RAISE EXCEPTION 'Only Admin can post financial reversals';
    END IF;
    IF j.reversal_of_id IS NULL OR j.source_id <> j.reversal_of_id THEN
      RAISE EXCEPTION 'Reversal journal must reference original journal entry';
    END IF;
    SELECT * INTO orig FROM public.journal_entries WHERE id = j.reversal_of_id AND business_id = j.business_id;
    IF orig.id IS NULL OR orig.source_type = 'reversal' THEN
      RAISE EXCEPTION 'Cannot reverse a missing or already-reversal journal entry';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.financial_reversals fr
      WHERE fr.business_id = j.business_id
        AND fr.original_journal_entry_id = orig.id
        AND fr.reversal_journal_entry_id = j.id
    ) THEN
      RAISE EXCEPTION 'Reversal journal requires a matching financial_reversals record with reason';
    END IF;
    SELECT count(*) INTO mismatch_count FROM (
      SELECT account_id, sum(debit_cents) AS d, sum(credit_cents) AS c
      FROM public.journal_lines WHERE journal_entry_id = orig.id GROUP BY account_id
    ) o
    FULL OUTER JOIN (
      SELECT account_id, sum(credit_cents) AS d, sum(debit_cents) AS c
      FROM public.journal_lines WHERE journal_entry_id = j.id GROUP BY account_id
    ) r USING (account_id)
    WHERE coalesce(o.d, -1) <> coalesce(r.d, -2) OR coalesce(o.c, -1) <> coalesce(r.c, -2);
    IF mismatch_count > 0 THEN
      RAISE EXCEPTION 'Reversal journal lines must exactly invert original journal entry';
    END IF;
    RETURN NEW;
  END IF;

  CASE j.source_type
    WHEN 'loan_opening' THEN
      SELECT * INTO ln FROM public.loans WHERE id = source_id AND business_id = j.business_id;
      IF ln.id IS NULL OR ln.opening_principal_cents <= 0 THEN
        RAISE EXCEPTION 'Loan opening journal requires a loan with positive opening principal';
      END IF;
      expected := ln.opening_principal_cents;
      debit_type := 'owner_equity';
      credit_type := 'loan_liability';
      IF EXISTS (
        SELECT 1 FROM public.journal_lines l JOIN public.accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = j.id AND (a.is_cash_account OR a.account_type IN ('operating_expenses','capital_expenditure','customer_revenue'))
      ) THEN
        RAISE EXCEPTION 'Opening loan liability entry must be strictly non-cash and non-operating';
      END IF;
    WHEN 'expense' THEN
      SELECT initial_paid_amount_cents, account_id INTO expected, credit_account
      FROM public.expenses WHERE id = source_id AND business_id = j.business_id AND journal_entry_id = j.id;
    WHEN 'expense_settlement' THEN
      SELECT amount_cents, account_id INTO expected, credit_account
      FROM public.expense_settlements WHERE id = source_id AND business_id = j.business_id AND journal_entry_id = j.id;
    WHEN 'wage_payment' THEN
      SELECT total_amount_cents, account_id INTO expected, credit_account
      FROM public.wage_payments WHERE id = source_id AND business_id = j.business_id AND journal_entry_id = j.id;
    WHEN 'customer_receipt' THEN
      SELECT amount_cents, account_id INTO expected, debit_account
      FROM public.customer_receipts WHERE id = source_id AND business_id = j.business_id AND journal_entry_id = j.id;
      credit_type := 'customer_revenue';
    WHEN 'grant_receipt' THEN
      SELECT amount_cents, account_id INTO expected, debit_account
      FROM public.funding_receipts WHERE id = source_id AND business_id = j.business_id AND journal_entry_id = j.id;
      credit_type := 'restricted_grant_income';
    WHEN 'loan_advance', 'loan_repayment' THEN
      SELECT * INTO ev FROM public.loan_events
      WHERE id = source_id AND business_id = j.business_id AND journal_entry_id = j.id
        AND event_type = CASE WHEN j.source_type = 'loan_advance' THEN 'advance' ELSE 'repayment' END;
      expected := ev.amount_cents;
      IF j.source_type = 'loan_advance' THEN debit_account := ev.account_id; credit_type := 'loan_liability';
      ELSE credit_account := ev.account_id; END IF;
    WHEN 'transfer' THEN
      SELECT * INTO t FROM public.transfers WHERE id = source_id AND business_id = j.business_id AND journal_entry_id = j.id AND status = 'matched';
      expected := t.amount_cents; debit_account := t.to_account_id;
      IF t.transfer_kind = 'internal_transfer' THEN credit_account := t.from_account_id;
      ELSIF t.transfer_kind = 'lender_advance' THEN
        credit_type := 'loan_liability';
        IF NOT EXISTS (SELECT 1 FROM public.loan_events e WHERE e.business_id = j.business_id AND e.journal_entry_id = j.id AND e.event_type = 'advance' AND e.amount_cents = t.amount_cents AND e.account_id = t.to_account_id) THEN
          RAISE EXCEPTION 'Lender transfer needs one matching loan event';
        END IF;
      ELSIF t.transfer_kind = 'restricted_grant' THEN credit_type := 'restricted_grant_income';
      ELSE credit_type := 'owner_equity'; END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported financial posting source';
  END CASE;

  IF TG_TABLE_NAME <> 'journal_entries' THEN
    IF TG_TABLE_NAME = 'loan_events' AND j.source_type = 'transfer' THEN
      IF t.transfer_kind <> 'lender_advance' OR NEW.event_type <> 'advance' OR NEW.amount_cents <> expected OR NEW.account_id <> debit_account THEN
        RAISE EXCEPTION 'Loan event must match transfer';
      END IF;
    ELSIF TG_TABLE_NAME <> (CASE j.source_type
      WHEN 'expense' THEN 'expenses'
      WHEN 'expense_settlement' THEN 'expense_settlements'
      WHEN 'wage_payment' THEN 'wage_payments'
      WHEN 'customer_receipt' THEN 'customer_receipts'
      WHEN 'grant_receipt' THEN 'funding_receipts'
      WHEN 'loan_advance' THEN 'loan_events'
      WHEN 'loan_repayment' THEN 'loan_events'
      WHEN 'transfer' THEN 'transfers'
      WHEN 'loan_opening' THEN 'loans'
    END) OR NEW.id <> source_id THEN
      RAISE EXCEPTION 'Source must point back to its own posting';
    END IF;
  END IF;

  SELECT sum(debit_cents) INTO observed FROM public.journal_lines WHERE journal_entry_id = j.id;
  IF expected IS NULL OR observed IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Posting must match its authoritative source amount';
  END IF;
  IF debit_account IS NOT NULL AND expected <> (SELECT coalesce(sum(debit_cents),0) FROM public.journal_lines WHERE journal_entry_id = j.id AND account_id = debit_account) THEN
    RAISE EXCEPTION 'Posting debit account mismatch';
  END IF;
  IF debit_type IS NOT NULL AND expected <> (SELECT coalesce(sum(l.debit_cents),0) FROM public.journal_lines l JOIN public.accounts a ON a.id = l.account_id WHERE l.journal_entry_id = j.id AND a.account_type = debit_type) THEN
    RAISE EXCEPTION 'Posting debit purpose mismatch';
  END IF;
  IF credit_account IS NOT NULL AND expected <> (SELECT coalesce(sum(credit_cents),0) FROM public.journal_lines WHERE journal_entry_id = j.id AND account_id = credit_account) THEN
    RAISE EXCEPTION 'Posting credit account mismatch';
  END IF;
  IF credit_type IS NOT NULL AND expected <> (SELECT coalesce(sum(l.credit_cents),0) FROM public.journal_lines l JOIN public.accounts a ON a.id = l.account_id WHERE l.journal_entry_id = j.id AND a.account_type = credit_type) THEN
    RAISE EXCEPTION 'Posting credit purpose mismatch';
  END IF;
  IF j.source_type = 'wage_payment' AND expected <> (SELECT coalesce(sum(amount_cents),0) FROM public.wage_allocations WHERE wage_payment_id = source_id) THEN
    RAISE EXCEPTION 'Wage allocations must equal payment';
  END IF;
  RETURN NEW;
END $$;

-- 6. Reversal-aware receipt, settlement, wage allocation, and loan repayment guards
CREATE OR REPLACE FUNCTION public.worktrack_receipt_totals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE target uuid; received bigint; expected bigint;
BEGIN
  target := CASE WHEN TG_TABLE_NAME = 'payment_milestones' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'milestone_id')::uuid END;
  SELECT received_amount_cents INTO received FROM public.payment_milestones WHERE id = target;
  SELECT coalesce(sum(cr.amount_cents), 0) INTO expected
  FROM public.customer_receipts cr
  WHERE cr.milestone_id = target
    AND NOT EXISTS (
      SELECT 1 FROM public.financial_reversals fr
      WHERE fr.business_id = cr.business_id AND fr.target_type = 'customer_receipt' AND fr.target_id = cr.id
    );
  IF received <> expected THEN
    RAISE EXCEPTION 'Customer receipts must reconcile to non-reversed payment history';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.worktrack_settlement_totals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE target uuid; e public.expenses; is_reversed boolean; settled bigint;
BEGIN
  target := CASE WHEN TG_TABLE_NAME = 'expenses' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'expense_id')::uuid END;
  SELECT * INTO e FROM public.expenses WHERE id = target;
  SELECT EXISTS (
    SELECT 1 FROM public.financial_reversals fr
    WHERE fr.business_id = e.business_id AND fr.target_type = 'expense' AND fr.target_id = e.id
  ) INTO is_reversed;
  IF is_reversed THEN
    IF e.paid_amount_cents <> 0 THEN
      RAISE EXCEPTION 'Reversed expense must have zero paid amount';
    END IF;
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(es.amount_cents), 0) INTO settled
  FROM public.expense_settlements es
  WHERE es.expense_id = target
    AND NOT EXISTS (
      SELECT 1 FROM public.financial_reversals fr
      WHERE fr.business_id = es.business_id AND fr.target_type = 'expense_settlement' AND fr.target_id = es.id
    );
  IF e.paid_amount_cents <> e.initial_paid_amount_cents + settled THEN
    RAISE EXCEPTION 'Paid expense amount must reconcile to non-reversed settlement history';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.worktrack_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE earned bigint; allocated bigint;
BEGIN
  IF NEW.payroll_run_id IS NOT NULL THEN
    SELECT net_pay_cents INTO earned FROM public.payroll_earnings
    WHERE payroll_run_id = NEW.payroll_run_id AND worker_id = NEW.worker_id AND business_id = NEW.business_id FOR UPDATE;
    IF earned IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.payroll_runs WHERE id = NEW.payroll_run_id AND business_id = NEW.business_id AND status = 'approved'
    ) THEN
      RAISE EXCEPTION 'Approved worker earnings required';
    END IF;
    SELECT coalesce(sum(wa.amount_cents), 0) INTO allocated
    FROM public.wage_allocations wa
    WHERE wa.payroll_run_id = NEW.payroll_run_id
      AND wa.worker_id = NEW.worker_id
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_reversals fr
        WHERE fr.business_id = wa.business_id AND fr.target_type = 'wage_payment' AND fr.target_id = wa.wage_payment_id
      );
    IF allocated + NEW.amount_cents > earned THEN
      RAISE EXCEPTION 'Allocation exceeds worker earnings';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.worktrack_loan_repayment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE remaining bigint;
BEGIN
  IF NEW.event_type = 'repayment' THEN
    SELECT opening_principal_cents + coalesce((
      SELECT sum(CASE WHEN e.event_type = 'repayment' THEN -e.amount_cents ELSE e.amount_cents END)
      FROM public.loan_events e
      WHERE e.loan_id = NEW.loan_id
        AND NOT EXISTS (
          SELECT 1 FROM public.financial_reversals fr
          WHERE fr.business_id = e.business_id
            AND fr.target_type IN ('loan_advance','loan_repayment')
            AND fr.target_id = e.id
        )
    ), 0) INTO remaining
    FROM public.loans WHERE id = NEW.loan_id AND business_id = NEW.business_id;
    IF remaining IS NULL OR NEW.amount_cents > remaining THEN
      RAISE EXCEPTION 'Repayment exceeds remaining loan principal';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 7. Extend allowlisted tables in worktrack_apply_changes and worktrack_read_bundle with financial_reversals
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
  IF tab <> ALL(ARRAY['accounts','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','loans','loan_events','loan_repayment_schedules','financial_reversals','assets','asset_checks','defects','asset_services','weekly_reports','notifications','notification_preferences','customer_receipts','expense_settlements','forecast_assumptions','funding_receipts']) THEN RAISE EXCEPTION 'Unsupported table'; END IF;
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
  IF tab<>ALL(ARRAY['accounts','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','loans','loan_events','loan_repayment_schedules','financial_reversals','customer_receipts','expense_settlements','forecast_assumptions','funding_receipts','assets','asset_checks','defects','asset_services','weekly_reports','notifications','notification_preferences','asset_private','notification_receipts']) THEN RAISE EXCEPTION 'Unsupported read table'; END IF;
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) FROM public.%I t WHERE business_id=$1',tab) INTO values_json USING p_business;
  tables_json:=tables_json||jsonb_build_object(tab,values_json);
 END LOOP;
 RETURN jsonb_build_object('epoch',epoch,'tables',tables_json);
END $$;
REVOKE ALL ON FUNCTION public.worktrack_read_bundle(uuid,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_read_bundle(uuid,text[]) TO authenticated;

-- 8. Extend worktrack_capture_offline for interruptions (rain, vehicle breakdown, downtime) and exception reset
CREATE OR REPLACE FUNCTION public.worktrack_capture_offline(p_business uuid,p_epoch bigint,p_key text,p_kind text,p_payload jsonb,p_base_revision integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; job uuid; actor_email text; oldrow jsonb; newrow jsonb; target uuid; base integer; side text; created uuid; vstate text;
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin','owner','supervisor']::public.app_role[]) THEN RAISE EXCEPTION 'Active membership required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 IF (SELECT data_epoch FROM public.businesses WHERE id=p_business)<>p_epoch OR (SELECT maintenance_mode FROM public.businesses WHERE id=p_business) THEN RAISE EXCEPTION 'Obsolete offline draft or maintenance mode'; END IF;
 SELECT result_json INTO result FROM public.sync_idempotency_keys WHERE business_id=p_business AND idempotency_key=p_key AND processed_by=auth.uid();
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT email INTO actor_email FROM auth.users WHERE id=auth.uid();
 vstate:=CASE WHEN public.has_business_role(p_business,ARRAY['admin','owner']::public.app_role[]) THEN 'verified' ELSE 'reported' END;
 job:=(p_payload->>'job_id')::uuid;
 IF p_kind IN ('team','exception','reset_exception','progress','interruption') AND (job IS NULL OR NOT public.is_assigned_to_job(p_business,job)) THEN RAISE EXCEPTION 'Assigned job required'; END IF;
 IF p_kind IN ('team','exception') THEN
  IF p_kind='exception' AND NOT EXISTS(SELECT 1 FROM public.worker_assignments wa WHERE wa.business_id=p_business AND wa.worker_id=(p_payload->>'worker_id')::uuid AND wa.job_id=job AND wa.assigned_from<=(p_payload->>'work_date')::date AND (wa.assigned_to IS NULL OR wa.assigned_to>=(p_payload->>'work_date')::date)) THEN RAISE EXCEPTION 'Worker is not assigned on this date'; END IF;
  IF p_kind='team' THEN SELECT to_jsonb(t) INTO oldrow FROM public.team_days t WHERE business_id=p_business AND job_id=job AND work_date=(p_payload->>'work_date')::date;
  ELSE SELECT to_jsonb(t) INTO oldrow FROM public.attendance_entries t WHERE business_id=p_business AND job_id=job AND worker_id=(p_payload->>'worker_id')::uuid AND work_date=(p_payload->>'work_date')::date; END IF;
  base:=coalesce((oldrow->>'revision')::int,0);
  IF base<>p_base_revision THEN RETURN jsonb_build_object('status','conflict','server',oldrow,'revision',base); END IF;
  target:=coalesce((oldrow->>'id')::uuid,gen_random_uuid());
  newrow:=p_payload||jsonb_build_object('id',target,'business_id',p_business,'revision',base+1,'verification_state',vstate,'updated_by_email',actor_email,'updated_at',now());
  IF p_kind='team' THEN
   INSERT INTO public.team_days SELECT (jsonb_populate_record(NULL::public.team_days,newrow)).* ON CONFLICT(business_id,job_id,work_date) DO UPDATE SET day_status=excluded.day_status,normal_hours=excluded.normal_hours,weekday_ot_hours=excluded.weekday_ot_hours,saturday_hours=excluded.saturday_hours,sunday_hours=excluded.sunday_hours,public_holiday_hours=excluded.public_holiday_hours,interruption_reason=excluded.interruption_reason,notes=excluded.notes,revision=excluded.revision,verification_state=excluded.verification_state,updated_by_email=excluded.updated_by_email,updated_at=excluded.updated_at;
  ELSE
   INSERT INTO public.attendance_entries SELECT (jsonb_populate_record(NULL::public.attendance_entries,newrow||jsonb_build_object('is_override',true))).* ON CONFLICT(business_id,worker_id,job_id,work_date) DO UPDATE SET day_status=excluded.day_status,normal_hours=excluded.normal_hours,weekday_ot_hours=excluded.weekday_ot_hours,saturday_hours=excluded.saturday_hours,sunday_hours=excluded.sunday_hours,public_holiday_hours=excluded.public_holiday_hours,is_override=true,override_reason=excluded.override_reason,revision=excluded.revision,verification_state=excluded.verification_state,updated_by_email=excluded.updated_by_email,updated_at=excluded.updated_at;
  END IF;
 ELSIF p_kind='reset_exception' THEN
  DELETE FROM public.attendance_entries
  WHERE business_id=p_business AND job_id=job AND worker_id=(p_payload->>'worker_id')::uuid AND work_date=(p_payload->>'work_date')::date
  RETURNING id INTO target;
  target:=coalesce(target,gen_random_uuid());
 ELSIF p_kind='progress' THEN
  target:=gen_random_uuid();
  FOR side IN SELECT jsonb_array_elements_text(p_payload->'verge_sides') LOOP
   created:=gen_random_uuid();
   newrow:=(p_payload-'verge_sides')||jsonb_build_object('id',created,'business_id',p_business,'verge_side',side,'revision',1,'submitted_by_email',actor_email,'verification_state','reported','created_at',now(),'updated_at',now());
   INSERT INTO public.progress_entries SELECT (jsonb_populate_record(NULL::public.progress_entries,newrow)).*;
   target:=created;
  END LOOP;
 ELSIF p_kind='interruption' THEN
  target:=gen_random_uuid();
  newrow:=p_payload||jsonb_build_object('id',target,'business_id',p_business,'submitted_by_email',actor_email,'created_at',now());
  INSERT INTO public.interruptions SELECT (jsonb_populate_record(NULL::public.interruptions,newrow)).*;
 ELSE RAISE EXCEPTION 'Unsupported offline capture';
 END IF;
 result:=jsonb_build_object('status','saved','entityId',target);
 INSERT INTO public.sync_idempotency_keys(business_id,idempotency_key,entity_type,entity_id,processed_by,result_json)
 VALUES(p_business,p_key,CASE WHEN p_kind='progress' THEN 'progress_entry' WHEN p_kind='interruption' THEN 'interruption' ELSE 'attendance' END,target::text,auth.uid(),result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_capture_offline(uuid,bigint,text,text,jsonb,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_capture_offline(uuid,bigint,text,text,jsonb,integer) TO authenticated;