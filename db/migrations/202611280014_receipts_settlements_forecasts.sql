CREATE UNIQUE INDEX milestone_id_business_unique ON public.payment_milestones(id,business_id);
CREATE TABLE public.customer_receipts (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES public.businesses(id),milestone_id uuid NOT NULL,job_id uuid NOT NULL,receipt_date date NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),account_id uuid NOT NULL,reference text NOT NULL DEFAULT '',journal_entry_id uuid NOT NULL,recorded_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(milestone_id,business_id) REFERENCES public.payment_milestones(id,business_id),FOREIGN KEY(job_id,business_id) REFERENCES public.jobs(id,business_id),FOREIGN KEY(account_id,business_id) REFERENCES public.accounts(id,business_id),FOREIGN KEY(journal_entry_id,business_id) REFERENCES public.journal_entries(id,business_id),UNIQUE(journal_entry_id)
);
GRANT SELECT,INSERT ON public.customer_receipts TO authenticated;
GRANT ALL ON public.customer_receipts TO service_role;
ALTER TABLE public.customer_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY receipts_read ON public.customer_receipts FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY receipts_post ON public.customer_receipts FOR INSERT TO authenticated WITH CHECK(public.has_business_role(business_id,ARRAY['admin']::public.app_role[]));
CREATE TABLE public.expense_settlements (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES public.businesses(id),expense_id uuid NOT NULL,payment_date date NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),account_id uuid NOT NULL,reference text NOT NULL DEFAULT '',journal_entry_id uuid NOT NULL,recorded_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(expense_id,business_id) REFERENCES public.expenses(id,business_id),FOREIGN KEY(account_id,business_id) REFERENCES public.accounts(id,business_id),FOREIGN KEY(journal_entry_id,business_id) REFERENCES public.journal_entries(id,business_id),UNIQUE(journal_entry_id)
);
GRANT SELECT,INSERT ON public.expense_settlements TO authenticated;
GRANT ALL ON public.expense_settlements TO service_role;
ALTER TABLE public.expense_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY settlements_read ON public.expense_settlements FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY settlements_post ON public.expense_settlements FOR INSERT TO authenticated WITH CHECK(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE TABLE public.forecast_assumptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES public.businesses(id),job_id uuid NOT NULL,weekly_cash_cost_cents bigint NOT NULL CHECK(weekly_cash_cost_cents>=0),existing_arrears_cents bigint NOT NULL DEFAULT 0 CHECK(existing_arrears_cents>=0),receipt_delay_weeks integer NOT NULL DEFAULT 0 CHECK(receipt_delay_weeks BETWEEN 0 AND 52),notes text NOT NULL CHECK(length(trim(notes))>0),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,business_id) REFERENCES public.jobs(id,business_id),UNIQUE(business_id,job_id)
);
GRANT SELECT,INSERT,UPDATE ON public.forecast_assumptions TO authenticated;
GRANT ALL ON public.forecast_assumptions TO service_role;
ALTER TABLE public.forecast_assumptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY forecast_read ON public.forecast_assumptions FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY forecast_write ON public.forecast_assumptions FOR ALL TO authenticated USING(public.has_business_role(business_id,ARRAY['admin']::public.app_role[])) WITH CHECK(public.has_business_role(business_id,ARRAY['admin']::public.app_role[]));
ALTER TABLE public.expenses ADD COLUMN initial_paid_amount_cents bigint NOT NULL DEFAULT 0;
UPDATE public.expenses SET initial_paid_amount_cents=paid_amount_cents;
CREATE OR REPLACE FUNCTION public.worktrack_initial_expense_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.initial_paid_amount_cents:=NEW.paid_amount_cents;RETURN NEW;END $$;
CREATE TRIGGER initial_expense_payment BEFORE INSERT ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.worktrack_initial_expense_payment();
CREATE OR REPLACE FUNCTION public.worktrack_settlement_totals() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid; e public.expenses; BEGIN
 target:=CASE WHEN TG_TABLE_NAME='expenses' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'expense_id')::uuid END;
 SELECT * INTO e FROM public.expenses WHERE id=target;
 IF e.paid_amount_cents<>e.initial_paid_amount_cents+(SELECT coalesce(sum(amount_cents),0) FROM public.expense_settlements WHERE expense_id=target) THEN RAISE EXCEPTION 'Paid expense amount must reconcile to settlement history'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER expense_payment_total AFTER UPDATE ON public.expenses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_settlement_totals();
CREATE CONSTRAINT TRIGGER settlement_payment_total AFTER INSERT ON public.expense_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_settlement_totals();
CREATE OR REPLACE FUNCTION public.worktrack_receipt_totals() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid; received bigint; BEGIN
 target:=CASE WHEN TG_TABLE_NAME='payment_milestones' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'milestone_id')::uuid END;
 SELECT received_amount_cents INTO received FROM public.payment_milestones WHERE id=target;
 IF received<>(SELECT coalesce(sum(amount_cents),0) FROM public.customer_receipts WHERE milestone_id=target) THEN RAISE EXCEPTION 'Customer receipts must reconcile to payment history'; END IF;
 RETURN NEW;
END $$;
-- Apply to new receipts. Existing milestone history must be reconciled on VM;
-- no invented historical receipts are introduced by this upgrade.
CREATE CONSTRAINT TRIGGER receipt_history_total AFTER INSERT ON public.customer_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.worktrack_receipt_totals();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['customer_receipts','expense_settlements','forecast_assumptions'] LOOP
  EXECUTE format('CREATE TRIGGER epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.worktrack_epoch_guard()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['customer_receipts','expense_settlements'] LOOP
  EXECUTE format('CREATE TRIGGER actor_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.worktrack_row_guard()',tab);
 END LOOP;
END $$;
