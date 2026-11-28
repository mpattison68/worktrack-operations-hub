CREATE TABLE public.admin_operation_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id), actor_id uuid NOT NULL REFERENCES auth.users(id), action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.admin_operation_log TO authenticated;
GRANT ALL ON public.admin_operation_log TO service_role;
ALTER TABLE public.admin_operation_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_operations_read ON public.admin_operation_log FOR SELECT TO authenticated USING(public.has_business_role(business_id,ARRAY['admin']::public.app_role[]));
CREATE OR REPLACE FUNCTION public.worktrack_authorize_admin_operation(p_business uuid,p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.has_business_role(p_business,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Admin required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text,2));
 IF (SELECT count(*) FROM public.admin_operation_log WHERE actor_id=auth.uid() AND created_at>now()-interval '1 minute')>=10 THEN RAISE EXCEPTION 'Too many user changes. Wait one minute.'; END IF;
 INSERT INTO public.admin_operation_log(business_id,actor_id,action) VALUES(p_business,auth.uid(),p_action);
END $$;
REVOKE ALL ON FUNCTION public.worktrack_authorize_admin_operation(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_authorize_admin_operation(uuid,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.worktrack_manage_membership(p_business uuid,p_user uuid,p_role public.app_role,p_active boolean,p_jobs uuid[],p_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE email_address text; BEGIN
 PERFORM public.worktrack_authorize_admin_operation(p_business,'membership');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business::text,0));
 IF p_user=auth.uid() AND (NOT p_active OR p_role<>'admin') THEN RAISE EXCEPTION 'Cannot revoke or downgrade your own Admin access'; END IF;
 SELECT email INTO email_address FROM auth.users WHERE id=p_user;
 IF email_address IS NULL THEN RAISE EXCEPTION 'Auth user does not exist'; END IF;
 IF EXISTS(SELECT 1 FROM public.memberships WHERE user_id=p_user AND business_id<>p_business) AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE user_id=p_user AND business_id=p_business) THEN RAISE EXCEPTION 'Cannot link another business user'; END IF;
 INSERT INTO public.profiles(id,email,full_name) VALUES(p_user,email_address,p_name) ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.memberships(business_id,user_id,email,full_name,role,active,assigned_job_ids) VALUES(p_business,p_user,email_address,p_name,p_role,p_active,p_jobs)
 ON CONFLICT(business_id,user_id) DO UPDATE SET role=excluded.role,active=excluded.active,assigned_job_ids=excluded.assigned_job_ids,full_name=excluded.full_name,email=excluded.email;
 INSERT INTO public.audit_events(business_id,actor_user_id,actor_email,entity_type,entity_id,action,changed_fields)
 SELECT p_business,auth.uid(),u.email,'membership',p_user,'membership_update',jsonb_build_object('role',p_role,'active',p_active,'assigned_jobs',p_jobs) FROM auth.users u WHERE u.id=auth.uid();
END $$;
REVOKE ALL ON FUNCTION public.worktrack_manage_membership(uuid,uuid,public.app_role,boolean,uuid[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worktrack_manage_membership(uuid,uuid,public.app_role,boolean,uuid[],text) TO authenticated;
-- Only this transactional workflow may change memberships: protects last Admin
-- and validates same-tenant assignments even against direct API requests.
REVOKE INSERT,UPDATE ON public.memberships FROM authenticated;

CREATE OR REPLACE FUNCTION public.worktrack_audit_actor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NOT NULL THEN
  NEW.actor_user_id:=auth.uid(); SELECT email INTO NEW.actor_email FROM auth.users WHERE id=auth.uid();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audit_actor_stamp BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.worktrack_audit_actor();
-- Preserve old API signature, but never trust supplied actor email.
CREATE OR REPLACE FUNCTION public.worktrack_payroll_actor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NOT NULL THEN
  IF TG_OP='INSERT' THEN SELECT email INTO NEW.created_by_email FROM auth.users WHERE id=auth.uid(); END IF;
  IF NEW.status='approved' THEN
   IF NOT public.has_business_role(NEW.business_id,ARRAY['admin']::public.app_role[]) THEN RAISE EXCEPTION 'Only Admin approves payroll'; END IF;
   SELECT email INTO NEW.approved_by_email FROM auth.users WHERE id=auth.uid();
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER payroll_actor_guard BEFORE INSERT OR UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION public.worktrack_payroll_actor();
