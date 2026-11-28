CREATE TABLE public.asset_private (
 asset_id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES public.businesses(id),vin text,purchase_cost_cents bigint CHECK(purchase_cost_cents IS NULL OR purchase_cost_cents>=0),FOREIGN KEY(asset_id,business_id) REFERENCES public.assets(id,business_id) ON DELETE CASCADE
);
GRANT SELECT ON public.asset_private TO authenticated;
GRANT ALL ON public.asset_private TO service_role;
ALTER TABLE public.asset_private ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_private_management ON public.asset_private FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
INSERT INTO public.asset_private(asset_id,business_id,vin,purchase_cost_cents) SELECT id,business_id,vin,purchase_cost_cents FROM public.assets;
UPDATE public.assets SET vin=NULL,purchase_cost_cents=NULL;
CREATE OR REPLACE FUNCTION public.worktrack_asset_private() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.vin IS NOT NULL OR NEW.purchase_cost_cents IS NOT NULL THEN
  IF auth.uid() IS NOT NULL AND NOT public.has_business_role(NEW.business_id,ARRAY['admin','owner']::public.app_role[]) THEN RAISE EXCEPTION 'Private asset fields are management-only'; END IF;
  INSERT INTO public.asset_private(asset_id,business_id,vin,purchase_cost_cents) VALUES(NEW.id,NEW.business_id,NEW.vin,NEW.purchase_cost_cents) ON CONFLICT(asset_id) DO UPDATE SET vin=excluded.vin,purchase_cost_cents=excluded.purchase_cost_cents;
  UPDATE public.assets SET vin=NULL,purchase_cost_cents=NULL WHERE id=NEW.id;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER asset_private_store AFTER INSERT OR UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.worktrack_asset_private();
-- Acknowledgements/read state belong to each user, not a business-wide flag.
CREATE UNIQUE INDEX notifications_id_business_unique ON public.notifications(id,business_id);
CREATE TABLE public.notification_receipts (
 notification_id uuid NOT NULL,business_id uuid NOT NULL REFERENCES public.businesses(id),user_id uuid NOT NULL DEFAULT auth.uid(),read_at timestamptz NOT NULL DEFAULT now(),acknowledged_at timestamptz,PRIMARY KEY(notification_id,user_id),FOREIGN KEY(notification_id,business_id) REFERENCES public.notifications(id,business_id) ON DELETE CASCADE
);
GRANT SELECT,INSERT,UPDATE ON public.notification_receipts TO authenticated;
GRANT ALL ON public.notification_receipts TO service_role;
ALTER TABLE public.notification_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_receipts_own ON public.notification_receipts FOR ALL TO authenticated USING(user_id=auth.uid() AND public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[])) WITH CHECK(user_id=auth.uid() AND public.has_business_role(business_id,ARRAY['admin','owner']::public.app_role[]));
CREATE TRIGGER notification_receipt_epoch BEFORE INSERT OR UPDATE OR DELETE ON public.notification_receipts FOR EACH ROW EXECUTE FUNCTION public.worktrack_epoch_guard();

CREATE OR REPLACE FUNCTION public.guard_approved_payroll_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF auth.uid() IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF OLD.status IN ('approved','superseded') THEN
  IF TG_OP='UPDATE' AND OLD.status='approved' AND NEW.status='superseded' AND (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Approved payroll history is immutable; create correction revision';
 END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE OR REPLACE FUNCTION public.worktrack_payroll_child_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;biz uuid; BEGIN
 IF auth.uid() IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 rid:=(CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END->>'payroll_run_id')::uuid;
 biz:=(CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END->>'business_id')::uuid;
 IF EXISTS(SELECT 1 FROM public.payroll_runs WHERE id=rid AND business_id=biz AND status IN ('approved','superseded')) THEN RAISE EXCEPTION 'Approved payroll earnings/adjustments are immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER payroll_earnings_history BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_earnings FOR EACH ROW EXECUTE FUNCTION public.worktrack_payroll_child_guard();
CREATE TRIGGER payroll_adjustments_history BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_adjustments FOR EACH ROW EXECUTE FUNCTION public.worktrack_payroll_child_guard();
-- Remaining same-tenant links are checked for all new writes; old rows need
-- explicit validation rather than automatic deletion.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('progress_entries','job_id','jobs'),('interruptions','job_id','jobs'),('team_days','job_id','jobs'),('attendance_entries','job_id','jobs'),('attendance_entries','worker_id','workers'),('payroll_runs','job_id','jobs'),('payroll_runs','supersedes_run_id','payroll_runs'),('payroll_earnings','payroll_run_id','payroll_runs'),('payroll_earnings','worker_id','workers'),('payroll_adjustments','payroll_run_id','payroll_runs'),('payroll_adjustments','worker_id','workers')
 ) x(tab,col,parent) LOOP
 EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY(%I,business_id) REFERENCES public.%I(id,business_id) ON DELETE RESTRICT NOT VALID',r.tab,r.tab||'_'||r.col||'_tenant_fk',r.col,r.parent);
 END LOOP;
END $$;
