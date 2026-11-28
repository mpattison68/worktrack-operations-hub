-- Forward-only security correction. Never rewrite or fabricate existing financial history.
-- Table/API callers share the batch/reset lock; checks run before epoch validation.
CREATE FUNCTION public.worktrack_financial_write_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(NEW.business_id,OLD.business_id)::text,0));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_financial_write_lock() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['accounts','loans','loan_events','loan_repayment_schedules','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_settlements','payment_milestones','customer_receipts','transfers','funding_receipts','financial_reversals'] LOOP
  EXECUTE format('CREATE TRIGGER aa_financial_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.worktrack_financial_write_lock()',tab);
 END LOOP;
END $$;

-- Derive restricted status from the account, not caller flags. Restore principal locking.
CREATE OR REPLACE FUNCTION public.worktrack_loan_repayment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE remaining bigint; restricted boolean; cash boolean;
BEGIN
 PERFORM 1 FROM public.loans WHERE id=NEW.loan_id AND business_id=NEW.business_id FOR UPDATE;
 SELECT is_restricted,is_cash_account INTO restricted,cash FROM public.accounts WHERE id=NEW.account_id AND business_id=NEW.business_id;
 IF cash IS DISTINCT FROM true THEN RAISE EXCEPTION 'Loan event requires a same-business cash account'; END IF;
 NEW.used_restricted_funding:=restricted;
 IF NEW.event_type='repayment' AND restricted AND
    (NOT NEW.restricted_eligibility_approved OR NOT public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[])) THEN
  RAISE EXCEPTION 'Restricted debt repayment needs authorized eligibility approval';
 END IF;
 IF NEW.schedule_id IS NOT NULL AND (NEW.event_type<>'repayment' OR NOT EXISTS(
  SELECT 1 FROM public.loan_repayment_schedules s WHERE s.id=NEW.schedule_id AND s.business_id=NEW.business_id AND s.loan_id=NEW.loan_id
 )) THEN RAISE EXCEPTION 'Schedule instalment must belong to repayment loan'; END IF;
 SELECT l.opening_principal_cents+coalesce((
  SELECT sum(CASE WHEN e.event_type='repayment' THEN -e.amount_cents ELSE e.amount_cents END)
  FROM public.loan_events e WHERE e.loan_id=l.id AND e.business_id=l.business_id AND e.id<>NEW.id
   AND NOT EXISTS(SELECT 1 FROM public.financial_reversals fr WHERE fr.business_id=e.business_id AND fr.target_type IN ('loan_advance','loan_repayment') AND fr.target_id=e.id)
 ),0) INTO remaining FROM public.loans l WHERE l.id=NEW.loan_id AND l.business_id=NEW.business_id;
 IF remaining IS NULL OR (NEW.event_type='repayment' AND NEW.amount_cents>remaining) THEN RAISE EXCEPTION 'Repayment exceeds remaining loan principal'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER loan_repayment_guard ON public.loan_events;
CREATE TRIGGER loan_repayment_guard BEFORE INSERT OR UPDATE ON public.loan_events FOR EACH ROW EXECUTE FUNCTION public.worktrack_loan_repayment_guard();

-- Composite schedule link also blocks reassignment of a used schedule to another loan.
CREATE UNIQUE INDEX loan_schedule_tenant_loan_key ON public.loan_repayment_schedules(id,business_id,loan_id);
ALTER TABLE public.loan_events ADD CONSTRAINT loan_events_schedule_loan_fk
 FOREIGN KEY(schedule_id,business_id,loan_id) REFERENCES public.loan_repayment_schedules(id,business_id,loan_id) ON DELETE RESTRICT;

CREATE FUNCTION public.worktrack_financial_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NOT NULL THEN
  IF TG_TABLE_NAME='journal_entries' AND (to_jsonb(NEW)->>'source_type')='loan_opening' AND NOT public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[]) THEN
   RAISE EXCEPTION 'Only Admin can post opening loan liabilities';
  END IF;
  -- A matched transfer has an independently recorded Admin party, checked at commit.
  IF NEW.evidence_status='verified' AND NOT public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[])
     AND NOT (TG_TABLE_NAME='journal_entries' AND (to_jsonb(NEW)->>'source_type')='transfer') THEN
   RAISE EXCEPTION 'Only Admin verifies financial evidence';
  END IF;
  IF TG_TABLE_NAME IN ('customer_receipts','wage_payments') THEN
   NEW:=jsonb_populate_record(NEW,jsonb_build_object('verified_by',CASE WHEN NEW.evidence_status='verified' THEN auth.uid() ELSE NULL END));
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_financial_evidence_guard() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['journal_entries','customer_receipts','wage_payments','loan_events'] LOOP
  EXECUTE format('CREATE TRIGGER financial_evidence_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.worktrack_financial_evidence_guard()',tab);
 END LOOP;
END $$;

CREATE FUNCTION public.worktrack_financial_evidence_match() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.journal_entries; status public.evidence_status;
BEGIN
 SELECT * INTO j FROM public.journal_entries WHERE id=CASE WHEN TG_TABLE_NAME='journal_entries' THEN NEW.id ELSE (to_jsonb(NEW)->>'journal_entry_id')::uuid END AND business_id=NEW.business_id;
 CASE j.source_type
 WHEN 'customer_receipt' THEN SELECT evidence_status INTO status FROM public.customer_receipts WHERE journal_entry_id=j.id AND business_id=j.business_id;
 WHEN 'loan_advance','loan_repayment' THEN SELECT evidence_status INTO status FROM public.loan_events WHERE journal_entry_id=j.id AND business_id=j.business_id;
 WHEN 'wage_payment' THEN SELECT evidence_status INTO status FROM public.wage_payments WHERE journal_entry_id=j.id AND business_id=j.business_id;
 ELSE RETURN NEW;
 END CASE;
 IF status IS DISTINCT FROM j.evidence_status THEN RAISE EXCEPTION 'Financial source and journal verification must agree'; END IF;
 IF j.source_type='loan_repayment' AND (SELECT coalesce(sum(l.debit_cents),0) FROM public.journal_lines l JOIN public.accounts a ON a.id=l.account_id AND a.business_id=l.business_id WHERE l.journal_entry_id=j.id AND a.account_type='loan_liability')
   IS DISTINCT FROM (SELECT amount_cents FROM public.loan_events WHERE journal_entry_id=j.id AND business_id=j.business_id) THEN
  RAISE EXCEPTION 'Repayment must debit loan liability';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_financial_evidence_match() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['journal_entries','customer_receipts','wage_payments','loan_events'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER financial_evidence_match AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_financial_evidence_match()',tab);
 END LOOP;
END $$;

-- The original journal source unique key already prevents duplicate openings.
-- Enforce completeness too: a positive opening and its journal are one transaction.
CREATE FUNCTION public.worktrack_assert_loan_opening(biz uuid,loan uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l public.loans; j public.journal_entries; n integer; debit bigint; credit bigint;
BEGIN
 SELECT * INTO l FROM public.loans WHERE id=loan AND business_id=biz;
 IF l.id IS NULL THEN RAISE EXCEPTION 'Opening loan source must exist'; END IF;
 SELECT count(*) INTO n FROM public.journal_entries WHERE business_id=biz AND source_type='loan_opening' AND source_id=loan;
 IF l.opening_principal_cents=0 AND n=0 THEN RETURN; END IF;
 IF l.opening_principal_cents<=0 OR n<>1 THEN RAISE EXCEPTION 'Opening loan requires exactly one balanced non-cash posting'; END IF;
 SELECT * INTO j FROM public.journal_entries WHERE business_id=biz AND source_type='loan_opening' AND source_id=loan;
 SELECT coalesce(sum(debit_cents),0),coalesce(sum(credit_cents),0) INTO debit,credit FROM public.journal_lines WHERE journal_entry_id=j.id AND business_id=biz;
 IF debit<>l.opening_principal_cents OR credit<>debit OR j.evidence_status IS DISTINCT FROM (CASE WHEN l.opening_principal_verified THEN 'verified'::public.evidence_status ELSE 'reported'::public.evidence_status END)
  OR EXISTS(SELECT 1 FROM public.journal_lines x JOIN public.accounts a ON a.id=x.account_id AND a.business_id=x.business_id WHERE x.journal_entry_id=j.id AND (a.is_cash_account OR (x.debit_cents>0 AND a.account_type<>'owner_equity') OR (x.credit_cents>0 AND a.account_type<>'loan_liability'))) THEN
  RAISE EXCEPTION 'Opening loan ledger reconciliation failed';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_assert_loan_opening(uuid,uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.worktrack_loan_opening_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='loans' THEN PERFORM public.worktrack_assert_loan_opening(NEW.business_id,NEW.id);
 ELSIF NEW.source_type='loan_opening' THEN PERFORM public.worktrack_assert_loan_opening(NEW.business_id,NEW.source_id); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_loan_opening_integrity() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER loan_opening_integrity AFTER INSERT OR UPDATE ON public.loans DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_loan_opening_integrity();
CREATE CONSTRAINT TRIGGER loan_opening_integrity AFTER INSERT OR UPDATE ON public.journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_loan_opening_integrity();

-- Reversal markers are authoritative: validate from marker to target AND inverse posting.
CREATE FUNCTION public.worktrack_assert_reversal(fr public.financial_reversals) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target jsonb; tab text; original_id uuid; orig public.journal_entries; rev public.journal_entries; exp public.expenses; ev public.loan_events; tr public.transfers; remaining bigint;
BEGIN
 tab:=CASE fr.target_type WHEN 'customer_receipt' THEN 'customer_receipts' WHEN 'wage_payment' THEN 'wage_payments' WHEN 'expense' THEN 'expenses' WHEN 'expense_settlement' THEN 'expense_settlements' WHEN 'loan_advance' THEN 'loan_events' WHEN 'loan_repayment' THEN 'loan_events' WHEN 'transfer' THEN 'transfers' END;
 EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND business_id=$2',tab) INTO target USING fr.target_id,fr.business_id;
 IF target IS NULL OR (fr.target_type IN ('loan_advance','loan_repayment') AND target->>'event_type'<>(CASE WHEN fr.target_type='loan_advance' THEN 'advance' ELSE 'repayment' END)) THEN RAISE EXCEPTION 'Reversal target must exist in the same business with the correct type'; END IF;
 original_id:=(target->>'journal_entry_id')::uuid;
 IF fr.target_type='expense' THEN
  SELECT * INTO exp FROM public.expenses WHERE id=fr.target_id AND business_id=fr.business_id;
  IF exp.paid_amount_cents<>0 OR EXISTS(SELECT 1 FROM public.expense_settlements s WHERE s.expense_id=exp.id AND s.business_id=fr.business_id AND NOT EXISTS(SELECT 1 FROM public.financial_reversals r WHERE r.business_id=fr.business_id AND r.target_type='expense_settlement' AND r.target_id=s.id)) THEN
   RAISE EXCEPTION 'Reverse expense settlements first and reconcile paid amount';
  END IF;
  IF original_id IS NULL AND exp.initial_paid_amount_cents=0 AND fr.original_journal_entry_id IS NULL AND fr.reversal_journal_entry_id IS NULL THEN RETURN; END IF;
 END IF;
 IF original_id IS NULL OR original_id IS DISTINCT FROM fr.original_journal_entry_id OR fr.reversal_journal_entry_id IS NULL THEN RAISE EXCEPTION 'Reversal must identify target posting and its inverse'; END IF;
 SELECT * INTO orig FROM public.journal_entries WHERE id=original_id AND business_id=fr.business_id;
 SELECT * INTO rev FROM public.journal_entries WHERE id=fr.reversal_journal_entry_id AND business_id=fr.business_id;
 IF orig.id IS NULL OR orig.source_type='reversal' OR rev.id IS NULL OR rev.source_type<>'reversal' OR rev.source_id IS DISTINCT FROM orig.id OR rev.reversal_of_id IS DISTINCT FROM orig.id OR rev.evidence_status<>'verified' THEN RAISE EXCEPTION 'Reversal requires same-business verified inverse journal'; END IF;
 IF EXISTS(
  SELECT 1 FROM (SELECT account_id,sum(debit_cents) d,sum(credit_cents) c FROM public.journal_lines WHERE journal_entry_id=orig.id GROUP BY account_id) o
  FULL JOIN (SELECT account_id,sum(credit_cents) d,sum(debit_cents) c FROM public.journal_lines WHERE journal_entry_id=rev.id GROUP BY account_id) r USING(account_id)
  WHERE coalesce(o.d,-1)<>coalesce(r.d,-2) OR coalesce(o.c,-1)<>coalesce(r.c,-2)
 ) THEN RAISE EXCEPTION 'Reversal must exactly invert target posting'; END IF;
 IF fr.target_type='customer_receipt' AND EXISTS(
  SELECT 1 FROM public.payment_milestones m WHERE m.id=(target->>'milestone_id')::uuid AND m.business_id=fr.business_id AND m.received_amount_cents<>(
   SELECT coalesce(sum(c.amount_cents),0) FROM public.customer_receipts c WHERE c.milestone_id=m.id AND c.business_id=m.business_id AND NOT EXISTS(SELECT 1 FROM public.financial_reversals r WHERE r.business_id=c.business_id AND r.target_type='customer_receipt' AND r.target_id=c.id)
  )
 ) THEN RAISE EXCEPTION 'Reversed receipt must reconcile milestone total'; END IF;
 IF fr.target_type='expense_settlement' THEN
  SELECT * INTO exp FROM public.expenses WHERE id=(target->>'expense_id')::uuid AND business_id=fr.business_id;
  IF NOT EXISTS(SELECT 1 FROM public.financial_reversals r WHERE r.business_id=fr.business_id AND r.target_type='expense' AND r.target_id=exp.id) AND exp.paid_amount_cents<>exp.initial_paid_amount_cents+(
   SELECT coalesce(sum(s.amount_cents),0) FROM public.expense_settlements s WHERE s.expense_id=exp.id AND s.business_id=fr.business_id AND NOT EXISTS(SELECT 1 FROM public.financial_reversals r WHERE r.business_id=s.business_id AND r.target_type='expense_settlement' AND r.target_id=s.id)
  ) THEN RAISE EXCEPTION 'Reversed settlement must reconcile expense total'; END IF;
 END IF;
 IF fr.target_type IN ('loan_advance','loan_repayment') THEN
  SELECT * INTO ev FROM public.loan_events WHERE id=fr.target_id AND business_id=fr.business_id;
  SELECT l.opening_principal_cents+coalesce((SELECT sum(CASE WHEN e.event_type='repayment' THEN -e.amount_cents ELSE e.amount_cents END) FROM public.loan_events e WHERE e.loan_id=l.id AND e.business_id=l.business_id AND NOT EXISTS(SELECT 1 FROM public.financial_reversals r WHERE r.business_id=e.business_id AND r.target_type IN ('loan_advance','loan_repayment') AND r.target_id=e.id)),0) INTO remaining FROM public.loans l WHERE l.id=ev.loan_id AND l.business_id=fr.business_id;
  IF remaining<0 THEN RAISE EXCEPTION 'Reversal would overdraw loan principal; reverse repayments first'; END IF;
  IF orig.source_type='transfer' AND NOT EXISTS(SELECT 1 FROM public.financial_reversals r JOIN public.transfers t ON t.id=r.target_id AND t.business_id=r.business_id WHERE r.business_id=fr.business_id AND r.target_type='transfer' AND t.journal_entry_id=orig.id AND r.reversal_journal_entry_id=rev.id) THEN
   RAISE EXCEPTION 'Lender advance reversal must include linked transfer';
  END IF;
 END IF;
 IF fr.target_type='transfer' THEN
  SELECT * INTO tr FROM public.transfers WHERE id=fr.target_id AND business_id=fr.business_id;
  IF tr.status<>'matched' THEN RAISE EXCEPTION 'Only matched posted transfers can be reversed'; END IF;
  IF tr.transfer_kind='lender_advance' AND NOT EXISTS(SELECT 1 FROM public.loan_events e JOIN public.financial_reversals r ON r.target_id=e.id AND r.business_id=e.business_id AND r.target_type='loan_advance' WHERE e.journal_entry_id=orig.id AND e.business_id=fr.business_id AND r.reversal_journal_entry_id=rev.id) THEN RAISE EXCEPTION 'Transfer reversal must include linked loan advance'; END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.worktrack_assert_reversal(public.financial_reversals) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.worktrack_reversal_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN PERFORM public.worktrack_assert_reversal(NEW); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION public.worktrack_reversal_integrity() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER reversal_integrity AFTER INSERT ON public.financial_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_reversal_integrity();

-- Fail the upgrade on inconsistent legacy history; no auto backfill, reversal or deletion.
DO $$ DECLARE l public.loans; r public.financial_reversals; BEGIN
 FOR l IN SELECT * FROM public.loans LOOP PERFORM public.worktrack_assert_loan_opening(l.business_id,l.id); END LOOP;
 FOR r IN SELECT * FROM public.financial_reversals LOOP PERFORM public.worktrack_assert_reversal(r); END LOOP;
 IF EXISTS(SELECT 1 FROM public.loan_events e JOIN public.accounts a ON a.id=e.account_id AND a.business_id=e.business_id WHERE e.used_restricted_funding IS DISTINCT FROM a.is_restricted OR (e.event_type='repayment' AND a.is_restricted AND NOT e.restricted_eligibility_approved)) THEN RAISE EXCEPTION 'Legacy restricted funding flags require independent review'; END IF;
 IF EXISTS(SELECT 1 FROM public.journal_entries j JOIN (SELECT business_id,journal_entry_id,evidence_status FROM public.loan_events UNION ALL SELECT business_id,journal_entry_id,evidence_status FROM public.customer_receipts UNION ALL SELECT business_id,journal_entry_id,evidence_status FROM public.wage_payments) s ON s.journal_entry_id=j.id AND s.business_id=j.business_id WHERE j.source_type<>'transfer' AND j.evidence_status IS DISTINCT FROM s.evidence_status) THEN RAISE EXCEPTION 'Legacy financial evidence mismatch requires independent review'; END IF;
END $$;
-- Generic source trigger must not reference fields absent on sibling tables.
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
    IF TG_TABLE_NAME = 'expenses' AND (to_jsonb(NEW)->>'paid_amount_cents')::bigint = 0 THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'transfers' AND (to_jsonb(NEW)->>'status') <> 'matched' THEN RETURN NEW; END IF;
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
      IF t.transfer_kind <> 'lender_advance' OR (to_jsonb(NEW)->>'event_type') <> 'advance' OR (to_jsonb(NEW)->>'amount_cents')::bigint <> expected OR (to_jsonb(NEW)->>'account_id')::uuid <> debit_account THEN
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

