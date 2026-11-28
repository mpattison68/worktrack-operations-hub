-- Remove illustrative planning defaults from new production assessments.
ALTER TABLE public.assessments ALTER COLUMN benchmark_productivity_sqm SET DEFAULT 0;
ALTER TABLE public.assessments ALTER COLUMN productive_crew_size SET DEFAULT 0;
ALTER TABLE public.assessments ALTER COLUMN road_worker_daily_rate_cents SET DEFAULT 0;
ALTER TABLE public.assessments ALTER COLUMN cook_weekly_rate_cents SET DEFAULT 0;
ALTER TABLE public.assessments ALTER COLUMN include_cook SET DEFAULT false;
ALTER TABLE public.assessments ALTER COLUMN workdays_per_week SET DEFAULT 0;
ALTER TABLE public.assessments DROP CONSTRAINT assessments_benchmark_productivity_sqm_check;
ALTER TABLE public.assessments ADD CHECK(benchmark_productivity_sqm>=0);
ALTER TABLE public.assessments DROP CONSTRAINT assessments_productive_crew_size_check;
ALTER TABLE public.assessments ADD CHECK(productive_crew_size>=0);
ALTER TABLE public.assessments DROP CONSTRAINT assessments_workdays_per_week_check;
ALTER TABLE public.assessments ADD CHECK(workdays_per_week BETWEEN 0 AND 7);
CREATE OR REPLACE FUNCTION public.worktrack_scope_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF auth.uid() IS NOT NULL THEN
  IF TG_OP='UPDATE' AND NEW.revisions_json @> OLD.revisions_json IS NOT TRUE THEN RAISE EXCEPTION 'Scope revision history cannot be removed or changed'; END IF;
  IF NEW.status='approved' AND (NEW.benchmark_productivity_sqm<=0 OR NEW.productive_crew_size<=0 OR NEW.road_worker_daily_rate_cents<=0 OR NEW.workdays_per_week<=0 OR (NEW.include_cook AND NEW.cook_weekly_rate_cents<=0)) THEN RAISE EXCEPTION 'Confirm explicit productivity, crew, rates and calendar before approving scope'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='approved' AND NEW.status='approved' AND NEW IS DISTINCT FROM OLD AND (NEW.revision<>OLD.revision+1 OR jsonb_array_length(NEW.revisions_json)<>jsonb_array_length(OLD.revisions_json)+1) THEN RAISE EXCEPTION 'Approved scope changes require a new retained revision'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER scope_history_guard BEFORE INSERT OR UPDATE ON public.assessments FOR EACH ROW EXECUTE FUNCTION public.worktrack_scope_history();
CREATE OR REPLACE FUNCTION public.worktrack_transfer_parties() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE admin boolean; owner boolean; BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 admin:=public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[]);owner:=public.has_business_role(NEW.business_id,ARRAY['owner']::public.app_role[]);
 IF TG_OP='INSERT' THEN
  IF (NEW.reported_by_admin IS NOT NULL AND NOT admin) OR (NEW.confirmed_by_owner IS NOT NULL AND NOT owner) THEN RAISE EXCEPTION 'Cannot impersonate the other transfer party'; END IF;
 ELSE
  IF (NEW.amount_cents,NEW.transfer_date,NEW.from_account_id,NEW.to_account_id,NEW.transfer_kind,NEW.shared_reference) IS DISTINCT FROM (OLD.amount_cents,OLD.transfer_date,OLD.from_account_id,OLD.to_account_id,OLD.transfer_kind,OLD.shared_reference) THEN RAISE EXCEPTION 'Transfer financial facts are immutable'; END IF;
  IF (NEW.reported_by_admin IS DISTINCT FROM OLD.reported_by_admin AND NOT admin) OR (NEW.confirmed_by_owner IS DISTINCT FROM OLD.confirmed_by_owner AND NOT owner) THEN RAISE EXCEPTION 'Cannot impersonate the other transfer party'; END IF;
 END IF;
 IF admin AND NEW.reported_by_admin IS NOT NULL THEN NEW.reported_by_admin:=jsonb_set(NEW.reported_by_admin,'{userId}',to_jsonb(auth.uid()::text)); END IF;
 IF owner AND NEW.confirmed_by_owner IS NOT NULL THEN NEW.confirmed_by_owner:=jsonb_set(NEW.confirmed_by_owner,'{userId}',to_jsonb(auth.uid()::text)); END IF;
 IF NEW.status='matched' AND (NEW.reported_by_admin IS NULL OR NEW.confirmed_by_owner IS NULL OR NEW.journal_entry_id IS NULL) THEN RAISE EXCEPTION 'Both transfer parties and one posting are required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transfer_parties BEFORE INSERT OR UPDATE ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.worktrack_transfer_parties();
CREATE OR REPLACE FUNCTION public.worktrack_loan_repayment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE remaining bigint; restricted boolean; BEGIN
 PERFORM 1 FROM public.loans WHERE id=NEW.loan_id FOR UPDATE;
 SELECT opening_principal_cents+coalesce((SELECT sum(CASE WHEN event_type='repayment' THEN -amount_cents ELSE amount_cents END) FROM public.loan_events WHERE loan_id=NEW.loan_id),0) INTO remaining FROM public.loans WHERE id=NEW.loan_id AND business_id=NEW.business_id;
 IF NEW.event_type='repayment' AND NEW.amount_cents>remaining THEN RAISE EXCEPTION 'Repayment exceeds remaining loan principal'; END IF;
 SELECT is_restricted INTO restricted FROM public.accounts WHERE id=NEW.account_id AND business_id=NEW.business_id;
 NEW.used_restricted_funding:=coalesce(restricted,false);
 IF restricted AND NEW.event_type='repayment' AND (NOT NEW.restricted_eligibility_approved OR NOT public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[])) THEN RAISE EXCEPTION 'Restricted debt repayment needs authorized eligibility approval'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER loan_repayment_guard BEFORE INSERT ON public.loan_events FOR EACH ROW EXECUTE FUNCTION public.worktrack_loan_repayment_guard();
CREATE OR REPLACE FUNCTION public.worktrack_financial_source_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.journal_entries; expected bigint; observed bigint; BEGIN
 SELECT * INTO j FROM public.journal_entries WHERE id=NEW.id;
 CASE j.source_type
 WHEN 'expense' THEN SELECT initial_paid_amount_cents INTO expected FROM public.expenses WHERE id=j.source_id AND business_id=j.business_id AND journal_entry_id=j.id;
 WHEN 'expense_settlement' THEN SELECT amount_cents INTO expected FROM public.expense_settlements WHERE id=j.source_id AND business_id=j.business_id AND journal_entry_id=j.id;
 WHEN 'wage_payment' THEN SELECT total_amount_cents INTO expected FROM public.wage_payments WHERE id=j.source_id AND business_id=j.business_id AND journal_entry_id=j.id;
 WHEN 'customer_receipt' THEN SELECT amount_cents INTO expected FROM public.customer_receipts WHERE id=j.source_id AND business_id=j.business_id AND journal_entry_id=j.id;
 WHEN 'loan_advance','loan_repayment' THEN
  SELECT amount_cents INTO expected FROM public.loan_events WHERE journal_entry_id=j.id AND business_id=j.business_id;
 ELSE RETURN NEW;
 END CASE;
 SELECT sum(debit_cents) INTO observed FROM public.journal_lines WHERE journal_entry_id=j.id;
 IF expected IS NULL OR expected IS DISTINCT FROM observed THEN RAISE EXCEPTION 'Posting must match its authoritative source amount'; END IF;
 IF j.source_type='wage_payment' AND expected<>(SELECT coalesce(sum(amount_cents),0) FROM public.wage_allocations WHERE wage_payment_id=j.source_id) THEN RAISE EXCEPTION 'Wage allocations must equal total payment'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_source_check AFTER INSERT ON public.journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_financial_source_check();
