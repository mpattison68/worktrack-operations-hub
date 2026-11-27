-- ============================================================================
-- WorkTrack Increment D: Wage Payments, Expenses, Balanced Ledger, Loans & Cash
-- Authoritative spec: docs/specification.md Sections 9, 10, 11, 13, 16
-- Portable PostgreSQL 15+ migration (runs on self-hosted Docker Compose Supabase)
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE public.ledger_account_type AS ENUM (
    'bank', 'cash', 'restricted_funding', 'wages_payable',
    'operating_expenses', 'capital_expenditure', 'customer_revenue',
    'loan_liability', 'owner_equity', 'restricted_grant_income'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.evidence_status AS ENUM ('reported', 'verified', 'disputed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payment_method AS ENUM ('cash', 'bank_transfer', 'card', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. Ledger Accounts
CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  account_type public.ledger_account_type NOT NULL,
  is_cash_account boolean NOT NULL DEFAULT false,
  is_restricted boolean NOT NULL DEFAULT false,
  opening_balance_cents bigint NOT NULL DEFAULT 0,
  opening_balance_verified boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.accounts TO authenticated;
GRANT ALL ON public.accounts TO service_role;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounts_read ON public.accounts FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY accounts_write_admin ON public.accounts FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- 2. Immutable Balanced Journal Entries & Lines
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  entry_date date NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  job_id uuid,
  reference text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  evidence_status public.evidence_status NOT NULL DEFAULT 'reported',
  reversal_of_id uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source_type, source_id),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.journal_entries TO authenticated;
GRANT ALL ON public.journal_entries TO service_role;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY journal_entries_read ON public.journal_entries FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY journal_entries_write ON public.journal_entries FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY journal_entries_admin_verify ON public.journal_entries FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  journal_entry_id uuid NOT NULL,
  account_id uuid NOT NULL,
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo text NOT NULL DEFAULT '',
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0)),
  FOREIGN KEY (journal_entry_id, business_id) REFERENCES public.journal_entries(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, business_id) REFERENCES public.accounts(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT ON public.journal_lines TO authenticated;
GRANT ALL ON public.journal_lines TO service_role;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY journal_lines_read ON public.journal_lines FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY journal_lines_insert ON public.journal_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

-- 3. Wage Payments & Allocations (T13)
CREATE TABLE IF NOT EXISTS public.wage_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  job_id uuid,
  payment_date date NOT NULL,
  account_id uuid NOT NULL,
  method public.payment_method NOT NULL,
  reference text NOT NULL DEFAULT '',
  total_amount_cents bigint NOT NULL CHECK (total_amount_cents > 0),
  evidence_status public.evidence_status NOT NULL DEFAULT 'reported',
  evidence_note text NOT NULL DEFAULT '',
  journal_entry_id uuid NOT NULL,
  recorded_by uuid REFERENCES auth.users(id),
  verified_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  FOREIGN KEY (account_id, business_id) REFERENCES public.accounts(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, business_id) REFERENCES public.journal_entries(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT, UPDATE ON public.wage_payments TO authenticated;
GRANT ALL ON public.wage_payments TO service_role;
ALTER TABLE public.wage_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY wage_payments_read ON public.wage_payments FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY wage_payments_insert ON public.wage_payments FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY wage_payments_verify ON public.wage_payments FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.wage_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  wage_payment_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  payroll_run_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  FOREIGN KEY (wage_payment_id, business_id) REFERENCES public.wage_payments(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (worker_id, business_id) REFERENCES public.workers(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT ON public.wage_allocations TO authenticated;
GRANT ALL ON public.wage_allocations TO service_role;
ALTER TABLE public.wage_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY wage_allocations_read ON public.wage_allocations FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY wage_allocations_insert ON public.wage_allocations FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

-- Prevent over-allocation beyond payment total
CREATE OR REPLACE FUNCTION public.check_wage_allocation_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _payment_total bigint;
  _allocated_sum bigint;
BEGIN
  SELECT total_amount_cents INTO _payment_total
  FROM public.wage_payments
  WHERE id = NEW.wage_payment_id AND business_id = NEW.business_id;

  SELECT COALESCE(SUM(amount_cents), 0) INTO _allocated_sum
  FROM public.wage_allocations
  WHERE wage_payment_id = NEW.wage_payment_id AND business_id = NEW.business_id;

  IF _allocated_sum > _payment_total THEN
    RAISE EXCEPTION 'Wage allocations (%) cannot exceed wage payment total (%)', _allocated_sum, _payment_total;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_wage_allocation_total ON public.wage_allocations;
CREATE TRIGGER trg_check_wage_allocation_total
AFTER INSERT OR UPDATE ON public.wage_allocations
FOR EACH ROW EXECUTE FUNCTION public.check_wage_allocation_total();

-- 4. Expenses & Expense Requests (T23)
CREATE TABLE IF NOT EXISTS public.expense_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  job_id uuid,
  category text NOT NULL CHECK (category <> 'wages'),
  estimated_amount_cents bigint NOT NULL CHECK (estimated_amount_cents > 0),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  requested_by uuid REFERENCES auth.users(id),
  reviewed_by uuid REFERENCES auth.users(id),
  review_comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.expense_requests TO authenticated;
GRANT ALL ON public.expense_requests TO service_role;
ALTER TABLE public.expense_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY expense_requests_read ON public.expense_requests FOR SELECT TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (job_id IS NOT NULL AND public.is_assigned_to_job(business_id, job_id))
  );
CREATE POLICY expense_requests_insert ON public.expense_requests FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (job_id IS NOT NULL AND public.is_assigned_to_job(business_id, job_id))
  );
CREATE POLICY expense_requests_review ON public.expense_requests FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  job_id uuid,
  expense_date date NOT NULL,
  category text NOT NULL CHECK (category <> 'wages'),
  classification text NOT NULL DEFAULT 'operating' CHECK (classification IN ('operating', 'capital')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_amount_cents bigint NOT NULL CHECK (paid_amount_cents >= 0 AND paid_amount_cents <= amount_cents),
  payment_status text NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid', 'unpaid_payable', 'partially_paid')),
  account_id uuid,
  method public.payment_method NOT NULL DEFAULT 'cash',
  supplier_name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  fuel_litres numeric(10,2) CHECK (fuel_litres IS NULL OR fuel_litres > 0),
  fuel_price_per_litre_cents bigint CHECK (fuel_price_per_litre_cents IS NULL OR fuel_price_per_litre_cents > 0),
  vehicle_or_machine text NOT NULL DEFAULT '',
  odometer_km integer CHECK (odometer_km IS NULL OR odometer_km >= 0),
  receipt_object_key text,
  receipt_checksum_sha256 text,
  missing_receipt_reason text,
  needs_review boolean NOT NULL DEFAULT false,
  duplicate_warning_flag boolean NOT NULL DEFAULT false,
  expense_request_id uuid,
  unapproved_exception_flag boolean NOT NULL DEFAULT false,
  journal_entry_id uuid,
  evidence_status public.evidence_status NOT NULL DEFAULT 'reported',
  recorded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (receipt_object_key IS NOT NULL OR length(trim(COALESCE(missing_receipt_reason, ''))) > 0),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.expenses TO authenticated;
GRANT ALL ON public.expenses TO service_role;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY expenses_read ON public.expenses FOR SELECT TO authenticated
  USING (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (job_id IS NOT NULL AND public.is_assigned_to_job(business_id, job_id))
  );
CREATE POLICY expenses_insert ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (
    public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[])
    OR (job_id IS NOT NULL AND public.is_assigned_to_job(business_id, job_id))
  );
CREATE POLICY expenses_admin_update ON public.expenses FOR UPDATE TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- 5. Transfers & Reconciliation (T14)
CREATE TABLE IF NOT EXISTS public.transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  transfer_date date NOT NULL,
  from_account_id uuid,
  to_account_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  shared_reference text NOT NULL CHECK (length(trim(shared_reference)) > 0),
  description text NOT NULL DEFAULT '',
  transfer_kind text NOT NULL CHECK (transfer_kind IN ('internal_transfer', 'lender_advance', 'owner_contribution', 'restricted_grant')),
  reported_by_admin jsonb,
  confirmed_by_owner jsonb,
  status text NOT NULL DEFAULT 'pending_match' CHECK (status IN ('pending_match', 'matched', 'disputed')),
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.transfers TO authenticated;
GRANT ALL ON public.transfers TO service_role;
ALTER TABLE public.transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY transfers_read ON public.transfers FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY transfers_write ON public.transfers FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  reconciled_date date NOT NULL,
  ledger_balance_cents bigint NOT NULL,
  counted_balance_cents bigint NOT NULL,
  difference_cents bigint NOT NULL,
  note text NOT NULL DEFAULT '',
  recorded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, business_id) REFERENCES public.accounts(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT ON public.reconciliations TO authenticated;
GRANT ALL ON public.reconciliations TO service_role;
ALTER TABLE public.reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliations_read ON public.reconciliations FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY reconciliations_insert ON public.reconciliations FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- 6. Customer Payment Milestones & Receipts
CREATE TABLE IF NOT EXISTS public.payment_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL,
  label text NOT NULL CHECK (length(trim(label)) > 0),
  expected_date date NOT NULL,
  expected_amount_cents bigint NOT NULL CHECK (expected_amount_cents > 0),
  received_amount_cents bigint NOT NULL DEFAULT 0 CHECK (received_amount_cents >= 0),
  received_date date,
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'partial', 'received')),
  account_id uuid,
  reference text NOT NULL DEFAULT '',
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, business_id) REFERENCES public.jobs(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT, UPDATE ON public.payment_milestones TO authenticated;
GRANT ALL ON public.payment_milestones TO service_role;
ALTER TABLE public.payment_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY milestones_read ON public.payment_milestones FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY milestones_write_admin ON public.payment_milestones FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

-- 7. Zero-Interest Loans & Loan Events (T12, T15, T16)
CREATE TABLE IF NOT EXISTS public.loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  lender_name text NOT NULL CHECK (length(trim(lender_name)) > 0),
  opening_principal_cents bigint NOT NULL CHECK (opening_principal_cents >= 0),
  opening_principal_verified boolean NOT NULL DEFAULT false,
  interest_rate_percent numeric(4,2) NOT NULL DEFAULT 0 CHECK (interest_rate_percent = 0),
  security_asset_note text NOT NULL DEFAULT '',
  repayment_terms_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
GRANT SELECT, INSERT, UPDATE ON public.loans TO authenticated;
GRANT ALL ON public.loans TO service_role;
ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;

CREATE POLICY loans_read ON public.loans FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY loans_write_admin ON public.loans FOR ALL TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]))
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));

CREATE TABLE IF NOT EXISTS public.loan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  loan_id uuid NOT NULL,
  event_date date NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('advance', 'repayment', 'agreed_adjustment')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  account_id uuid NOT NULL,
  used_restricted_funding boolean NOT NULL DEFAULT false,
  restricted_eligibility_approved boolean NOT NULL DEFAULT false,
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  evidence_status public.evidence_status NOT NULL DEFAULT 'verified',
  journal_entry_id uuid NOT NULL,
  recorded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT used_restricted_funding OR event_type <> 'repayment' OR restricted_eligibility_approved),
  FOREIGN KEY (loan_id, business_id) REFERENCES public.loans(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, business_id) REFERENCES public.accounts(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, business_id) REFERENCES public.journal_entries(id, business_id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT ON public.loan_events TO authenticated;
GRANT ALL ON public.loan_events TO service_role;
ALTER TABLE public.loan_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY loan_events_read ON public.loan_events FOR SELECT TO authenticated
  USING (public.has_business_role(business_id, ARRAY['admin','owner']::public.app_role[]));
CREATE POLICY loan_events_insert_admin ON public.loan_events FOR INSERT TO authenticated
  WITH CHECK (public.has_business_role(business_id, ARRAY['admin']::public.app_role[]));