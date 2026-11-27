import type { AuthSession } from "@/lib/domain/types";
import type { PayrollRun } from "@/lib/domain/increment-c-types";
import type {
  AccountType,
  CashReconciliation,
  CashTransferRecord,
  EvidenceStatus,
  ExpenseCategory,
  ExpenseClassification,
  ExpensePaymentStatus,
  ExpenseRecord,
  ExpenseRequest,
  FinanceBundle,
  JournalEntry,
  JournalLine,
  JournalSourceType,
  LedgerAccount,
  LoanAccount,
  LoanEvent,
  LoanEventType,
  PaymentMethod,
  PaymentMilestone,
  ReceiptAttachmentMeta,
  WagePayment,
} from "@/lib/domain/increment-d-types";
import {
  allocateWorkerWagePayment,
  calculateFuelUnitCostCents,
  computeAccountBalanceCents,
  findDuplicateExpense,
  validateBalancedJournalLines,
} from "@/lib/domain/finance-calc";
import { assertBusinessBoundary, can } from "@/lib/permissions";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { SYNTHETIC_BIZ_A, SYNTHETIC_JOB_1, SYNTHETIC_JOB_2 } from "@/lib/data/synthetic-fixtures";

const STORAGE_KEY = "worktrack_synthetic_increment_d_v1";

function newId(): string {
  return crypto.randomUUID();
}

function createInitialFinanceStore(): FinanceBundle {
  const now = "2026-11-27T08:00:00.000Z";
  const accBank: LedgerAccount = {
    id: "acc-bank-a",
    businessId: SYNTHETIC_BIZ_A,
    code: "1010",
    name: "Business Bank Account (Unrestricted)",
    accountType: "bank",
    isCashAccount: true,
    isRestricted: false,
    openingBalanceCents: 3990000, // R 39 900.00 synthetic opening
    openingBalanceVerified: false,
    active: true,
  };
  const accCash: LedgerAccount = {
    id: "acc-cash-a",
    businessId: SYNTHETIC_BIZ_A,
    code: "1020",
    name: "Field Cash on Hand (Unrestricted)",
    accountType: "cash",
    isCashAccount: true,
    isRestricted: false,
    openingBalanceCents: 1000000, // R 10 000.00 synthetic opening (total unrestricted = R 49 900.00)
    openingBalanceVerified: false,
    active: true,
  };
  const accRestricted: LedgerAccount = {
    id: "acc-restricted-a",
    businessId: SYNTHETIC_BIZ_A,
    code: "1030",
    name: "Restricted Grant / Funding Account",
    accountType: "restricted_funding",
    isCashAccount: true,
    isRestricted: true,
    openingBalanceCents: 0,
    openingBalanceVerified: true,
    active: true,
  };
  const contra = (id: string, code: string, name: string, accountType: AccountType): LedgerAccount => ({
    id,
    businessId: SYNTHETIC_BIZ_A,
    code,
    name,
    accountType,
    isCashAccount: false,
    isRestricted: false,
    openingBalanceCents: 0,
    openingBalanceVerified: true,
    active: true,
  });

  return {
    accounts: [
      accBank,
      accCash,
      accRestricted,
      contra("acc-wages-payable-a", "2100", "Wages Payable / Arrears", "wages_payable"),
      contra("acc-loan-liability-a", "2200", "Zero-Interest Loan Liability", "loan_liability"),
      contra("acc-owner-equity-a", "3000", "Owner Contribution / Equity", "owner_equity"),
      contra("acc-customer-rev-a", "4000", "Customer Contract Receipts", "customer_revenue"),
      contra("acc-grant-inc-a", "4100", "Restricted Grant Funding", "restricted_grant_income"),
      contra("acc-opex-a", "5000", "Operating Expenses", "operating_expenses"),
      contra("acc-capex-a", "1500", "Capital Expenditure", "capital_expenditure"),
    ],
    journalEntries: [],
    wagePayments: [],
    expenses: [],
    expenseRequests: [],
    transfers: [],
    reconciliations: [],
    milestones: [
      {
        id: "ms-1",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        label: "Progress claim 1 (Synthetic)",
        expectedDate: "2026-12-18",
        expectedAmountCents: 18000000,
        receivedAmountCents: 0,
        receivedDate: null,
        status: "expected",
        accountId: null,
        reference: "SYN-INV-001",
        journalEntryId: null,
      },
      {
        id: "ms-2",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_2,
        label: "Second job progress receipt (Synthetic)",
        expectedDate: "2027-01-15",
        expectedAmountCents: 13500000,
        receivedAmountCents: 0,
        receivedDate: null,
        status: "expected",
        accountId: null,
        reference: "SYN-INV-002",
        journalEntryId: null,
      },
    ],
    loans: [
      {
        id: "loan-main-a",
        businessId: SYNTHETIC_BIZ_A,
        lenderName: "Equipment & Working-Capital Lender (Synthetic)",
        openingPrincipalCents: 25690000, // Candidate R 256 900.00 (unverified)
        openingPrincipalVerified: false,
        interestRatePercent: 0,
        securityAssetNote: "4-ton crew truck recorded as business asset; security status subject to signed agreement.",
        repaymentTermsNote:
          "R0 interest. Job 1 repayment R0. Job 2 progress receipt planned R120k–R150k (due 3 business days after receipt); final minimum R100k capped at remaining balance.",
        createdAt: now,
      },
    ],
    loanEvents: [],
  };
}

function loadStore(): FinanceBundle {
  if (typeof window === "undefined") return createInitialFinanceStore();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const initial = createInitialFinanceStore();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }
  try {
    return JSON.parse(raw) as FinanceBundle;
  } catch {
    const initial = createInitialFinanceStore();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }
}

function saveStore(state: FinanceBundle): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function findAccountByType(state: FinanceBundle, businessId: string, type: AccountType): LedgerAccount {
  const acc = state.accounts.find((a) => a.businessId === businessId && a.accountType === type);
  if (!acc) throw new Error(`Required ledger account (${type}) not configured for this business.`);
  return acc;
}

function appendBalancedJournalEntry(
  state: FinanceBundle,
  params: {
    businessId: string;
    entryDate: string;
    sourceType: JournalSourceType;
    sourceId: string;
    jobId: string | null;
    reference: string;
    description: string;
    evidenceStatus: EvidenceStatus;
    lines: JournalLine[];
    createdBy: string;
  },
): JournalEntry {
  // Enforce unique posting per source event (idempotency / no duplicate posting)
  const existing = state.journalEntries.find(
    (j) =>
      j.businessId === params.businessId &&
      j.sourceType === params.sourceType &&
      j.sourceId === params.sourceId,
  );
  if (existing) return existing;

  const err = validateBalancedJournalLines(params.lines);
  if (err) throw new Error(err);

  const entry: JournalEntry = {
    id: newId(),
    businessId: params.businessId,
    entryDate: params.entryDate,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    jobId: params.jobId,
    reference: params.reference,
    description: params.description,
    evidenceStatus: params.evidenceStatus,
    reversalOfId: null,
    lines: params.lines,
    createdBy: params.createdBy,
    createdAt: new Date().toISOString(),
  };
  state.journalEntries.unshift(entry);
  return entry;
}

export async function listFinanceBundle(session: AuthSession): Promise<FinanceBundle> {
  const canViewFinance = can(session.role, "loans.view") || can(session.role, "payroll.view");

  if (isSupabaseConfigured && supabase) {
    const { data: expData } = await supabase
      .from("expenses")
      .select("*")
      .eq("business_id", session.businessId)
      .order("expense_date", { ascending: false });
    // Full Supabase hydration falls back gracefully to empty arrays when tables are empty
    const mappedExpenses: ExpenseRecord[] = (expData ?? []).map((e) => ({
      id: e.id,
      businessId: e.business_id,
      jobId: e.job_id,
      expenseDate: e.expense_date,
      category: e.category,
      classification: e.classification,
      amountCents: Number(e.amount_cents),
      paidAmountCents: Number(e.paid_amount_cents),
      paymentStatus: e.payment_status,
      accountId: e.account_id,
      method: e.method,
      supplierName: e.supplier_name ?? "",
      description: e.description ?? "",
      reference: e.reference ?? "",
      fuelLitres: e.fuel_litres === null ? null : Number(e.fuel_litres),
      fuelPricePerLitreCents: e.fuel_price_per_litre_cents === null ? null : Number(e.fuel_price_per_litre_cents),
      vehicleOrMachine: e.vehicle_or_machine ?? "",
      odometerKm: e.odometer_km === null ? null : Number(e.odometer_km),
      receiptAttachment: null,
      missingReceiptReason: e.missing_receipt_reason,
      needsReview: e.needs_review,
      duplicateWarningFlag: e.duplicate_warning_flag,
      expenseRequestId: e.expense_request_id,
      unapprovedExceptionFlag: e.unapproved_exception_flag,
      journalEntryId: e.journal_entry_id,
      evidenceStatus: e.evidence_status,
      recordedBy: e.recorded_by,
      createdAt: e.created_at,
    }));
    return {
      accounts: [],
      journalEntries: [],
      wagePayments: [],
      expenses: mappedExpenses,
      expenseRequests: [],
      transfers: [],
      reconciliations: [],
      milestones: [],
      loans: [],
      loanEvents: [],
    };
  }

  const state = loadStore();
  const bizExpenses = state.expenses.filter((e) => e.businessId === session.businessId);
  const bizRequests = state.expenseRequests.filter((r) => r.businessId === session.businessId);

  if (!canViewFinance) {
    // Supervisor: only field expenses for assigned jobs; no wages, cash balances, ledger, or loans (T21)
    return {
      accounts: [],
      journalEntries: [],
      wagePayments: [],
      expenses: bizExpenses.filter((e) => e.jobId !== null && session.assignedJobIds.includes(e.jobId)),
      expenseRequests: bizRequests.filter(
        (r) => r.jobId !== null && session.assignedJobIds.includes(r.jobId),
      ),
      transfers: [],
      reconciliations: [],
      milestones: [],
      loans: [],
      loanEvents: [],
    };
  }

  return {
    accounts: state.accounts.filter((a) => a.businessId === session.businessId),
    journalEntries: state.journalEntries.filter((j) => j.businessId === session.businessId),
    wagePayments: state.wagePayments.filter((w) => w.businessId === session.businessId),
    expenses: bizExpenses,
    expenseRequests: bizRequests,
    transfers: state.transfers.filter((t) => t.businessId === session.businessId),
    reconciliations: state.reconciliations.filter((r) => r.businessId === session.businessId),
    milestones: state.milestones.filter((m) => m.businessId === session.businessId),
    loans: state.loans.filter((l) => l.businessId === session.businessId),
    loanEvents: state.loanEvents.filter((ev) => ev.businessId === session.businessId),
  };
}

export async function recordBulkWagePayment(
  session: AuthSession,
  input: {
    jobId: string | null;
    paymentDate: string;
    accountId: string;
    method: PaymentMethod;
    reference: string;
    evidenceNote: string;
    preferredRunId?: string | null;
    workerAmounts: Array<{ workerId: string; amountCents: number }>;
    approvedRuns: PayrollRun[];
  },
): Promise<WagePayment> {
  if (!can(session.role, "payroll.record_payment")) {
    throw new Error("Access denied: you do not have permission to record wage payments.");
  }
  const nonZero = input.workerAmounts.filter((w) => w.amountCents > 0);
  if (nonZero.length === 0) {
    throw new Error("Select at least one worker with a positive ZAR payment amount.");
  }

  const state = loadStore();
  const payAccount = state.accounts.find((a) => a.id === input.accountId);
  if (!payAccount || !payAccount.isCashAccount) {
    throw new Error("Select a valid cash or bank account.");
  }
  assertBusinessBoundary(session, payAccount.businessId, "account");
  if (payAccount.isRestricted) {
    throw new Error("Restricted funding accounts cannot be used for ordinary wage payments without explicit approval.");
  }

  const existingAllocations = state.wagePayments
    .filter((p) => p.businessId === session.businessId)
    .flatMap((p) => p.allocations);

  const paymentId = newId();
  const allAllocations = nonZero.flatMap((item) =>
    allocateWorkerWagePayment({
      wagePaymentId: paymentId,
      workerId: item.workerId,
      paymentAmountCents: item.amountCents,
      approvedRuns: input.approvedRuns,
      existingAllocations,
      preferredRunId: input.preferredRunId ?? null,
    }),
  );

  const totalAmountCents = nonZero.reduce((sum, item) => sum + item.amountCents, 0);
  const allocatedTotal = allAllocations.reduce((sum, a) => sum + a.amountCents, 0);
  if (allocatedTotal !== totalAmountCents) {
    throw new Error("Allocation total must match payment total exactly.");
  }

  const wagesPayable = findAccountByType(state, session.businessId, "wages_payable");
  const evidenceStatus: EvidenceStatus = session.role === "admin" ? "verified" : "reported";

  const journal = appendBalancedJournalEntry(state, {
    businessId: session.businessId,
    entryDate: input.paymentDate,
    sourceType: "wage_payment",
    sourceId: paymentId,
    jobId: input.jobId,
    reference: input.reference.trim() || `WAGES-${input.paymentDate}`,
    description: `Bulk wage payment (${nonZero.length} worker${nonZero.length === 1 ? "" : "s"})`,
    evidenceStatus,
    lines: [
      {
        id: newId(),
        accountId: wagesPayable.id,
        accountType: wagesPayable.accountType,
        debitCents: totalAmountCents,
        creditCents: 0,
        memo: "Reduce wages payable / record advance",
      },
      {
        id: newId(),
        accountId: payAccount.id,
        accountType: payAccount.accountType,
        debitCents: 0,
        creditCents: totalAmountCents,
        memo: `Cash outflow (${input.method})`,
      },
    ],
    createdBy: session.email,
  });

  const payment: WagePayment = {
    id: paymentId,
    businessId: session.businessId,
    jobId: input.jobId,
    paymentDate: input.paymentDate,
    accountId: payAccount.id,
    method: input.method,
    reference: input.reference.trim(),
    totalAmountCents,
    evidenceStatus,
    evidenceNote: input.evidenceNote.trim(),
    journalEntryId: journal.id,
    allocations: allAllocations,
    recordedBy: session.email,
    verifiedBy: session.role === "admin" ? session.email : null,
    createdAt: new Date().toISOString(),
  };

  state.wagePayments.unshift(payment);
  saveStore(state);
  return payment;
}

export async function updateWagePaymentEvidenceStatus(
  session: AuthSession,
  paymentId: string,
  status: EvidenceStatus,
): Promise<void> {
  if (!can(session.role, "payroll.reconcile")) {
    throw new Error("Access denied: only Management / Admin can verify or dispute payment evidence.");
  }
  const state = loadStore();
  const payment = state.wagePayments.find((p) => p.id === paymentId);
  if (!payment) throw new Error("Wage payment not found.");
  assertBusinessBoundary(session, payment.businessId, "wage payment");
  payment.evidenceStatus = status;
  payment.verifiedBy = status === "verified" ? session.email : null;
  const je = state.journalEntries.find((j) => j.id === payment.journalEntryId);
  if (je) je.evidenceStatus = status;
  saveStore(state);
}

export async function recordExpense(
  session: AuthSession,
  input: {
    jobId: string | null;
    expenseDate: string;
    category: ExpenseCategory;
    classification: ExpenseClassification;
    amountCents: number;
    paidAmountCents: number;
    paymentStatus: ExpensePaymentStatus;
    accountId: string | null;
    method: PaymentMethod;
    supplierName: string;
    description: string;
    reference: string;
    fuelLitres: number | null;
    vehicleOrMachine: string;
    odometerKm: number | null;
    receiptAttachment: ReceiptAttachmentMeta | null;
    missingReceiptReason: string | null;
    expenseRequestId?: string | null;
    unapprovedExceptionFlag?: boolean;
  },
): Promise<ExpenseRecord> {
  if (input.category === "wages") {
    throw new Error("Wages cannot be recorded as an expense. Use Payroll / Wage payments instead.");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Expense amount must be a positive ZAR value.");
  }
  if (!Number.isInteger(input.paidAmountCents) || input.paidAmountCents < 0 || input.paidAmountCents > input.amountCents) {
    throw new Error("Paid amount must be between R 0.00 and the total expense amount.");
  }
  if (input.category === "other" && !input.description.trim()) {
    throw new Error("Other expenses require a short description.");
  }
  if (!input.receiptAttachment && !input.missingReceiptReason?.trim()) {
    throw new Error("Attach a receipt photo or enter a missing-receipt reason.");
  }
  if (session.role === "supervisor" && (!input.jobId || !session.assignedJobIds.includes(input.jobId))) {
    throw new Error("Supervisors can only capture expenses for their assigned jobs.");
  }

  const state = loadStore();
  const dup = findDuplicateExpense(
    { expenseDate: input.expenseDate, amountCents: input.amountCents, reference: input.reference },
    state.expenses.filter((e) => e.businessId === session.businessId),
  );

  const expenseId = newId();
  let journalEntryId: string | null = null;
  const evidenceStatus: EvidenceStatus =
    session.role === "admin" && input.receiptAttachment ? "verified" : "reported";

  if (input.paidAmountCents > 0) {
    const payAccount =
      state.accounts.find((a) => a.id === input.accountId && a.businessId === session.businessId) ??
      findAccountByType(state, session.businessId, "cash");
    if (payAccount.isRestricted) {
      throw new Error("Restricted funding accounts cannot be used for ordinary expenses without approval.");
    }
    const debitAccount = findAccountByType(
      state,
      session.businessId,
      input.classification === "capital" ? "capital_expenditure" : "operating_expenses",
    );
    const je = appendBalancedJournalEntry(state, {
      businessId: session.businessId,
      entryDate: input.expenseDate,
      sourceType: "expense",
      sourceId: expenseId,
      jobId: input.jobId,
      reference: input.reference.trim() || `EXP-${input.expenseDate}`,
      description: `${input.category.replace(/_/g, " ")}${input.description.trim() ? `: ${input.description.trim()}` : ""}`,
      evidenceStatus,
      lines: [
        {
          id: newId(),
          accountId: debitAccount.id,
          accountType: debitAccount.accountType,
          debitCents: input.paidAmountCents,
          creditCents: 0,
          memo: input.classification === "capital" ? "Capital expenditure" : "Operating expense",
        },
        {
          id: newId(),
          accountId: payAccount.id,
          accountType: payAccount.accountType,
          debitCents: 0,
          creditCents: input.paidAmountCents,
          memo: `Paid via ${input.method}`,
        },
      ],
      createdBy: session.email,
    });
    journalEntryId = je.id;
  }

  const record: ExpenseRecord = {
    id: expenseId,
    businessId: session.businessId,
    jobId: input.jobId,
    expenseDate: input.expenseDate,
    category: input.category,
    classification: input.classification,
    amountCents: input.amountCents,
    paidAmountCents: input.paidAmountCents,
    paymentStatus: input.paymentStatus,
    accountId: input.accountId,
    method: input.method,
    supplierName: input.supplierName.trim(),
    description: input.description.trim(),
    reference: input.reference.trim(),
    fuelLitres: input.fuelLitres,
    fuelPricePerLitreCents: calculateFuelUnitCostCents(input.amountCents, input.fuelLitres),
    vehicleOrMachine: input.vehicleOrMachine.trim(),
    odometerKm: input.odometerKm,
    receiptAttachment: input.receiptAttachment,
    missingReceiptReason: input.receiptAttachment ? null : input.missingReceiptReason!.trim(),
    needsReview: !input.receiptAttachment || Boolean(dup) || Boolean(input.unapprovedExceptionFlag),
    duplicateWarningFlag: Boolean(dup),
    expenseRequestId: input.expenseRequestId ?? null,
    unapprovedExceptionFlag: Boolean(input.unapprovedExceptionFlag),
    journalEntryId,
    evidenceStatus,
    recordedBy: session.email,
    createdAt: new Date().toISOString(),
  };

  state.expenses.unshift(record);
  saveStore(state);
  return record;
}

export async function createExpenseRequest(
  session: AuthSession,
  input: { jobId: string | null; category: ExpenseCategory; estimatedAmountCents: number; description: string },
): Promise<ExpenseRequest> {
  if (!Number.isInteger(input.estimatedAmountCents) || input.estimatedAmountCents <= 0) {
    throw new Error("Estimated amount must be a positive ZAR value.");
  }
  if (!input.description.trim()) throw new Error("Describe what the expense request is for.");
  const state = loadStore();
  const req: ExpenseRequest = {
    id: newId(),
    businessId: session.businessId,
    jobId: input.jobId,
    category: input.category,
    estimatedAmountCents: input.estimatedAmountCents,
    description: input.description.trim(),
    status: "pending",
    requestedBy: session.email,
    reviewedBy: null,
    reviewComment: "",
    createdAt: new Date().toISOString(),
  };
  state.expenseRequests.unshift(req);
  saveStore(state);
  return req;
}

export async function reviewExpenseRequest(
  session: AuthSession,
  requestId: string,
  decision: "approved" | "declined",
  comment: string,
): Promise<void> {
  if (!can(session.role, "payroll.reconcile")) {
    throw new Error("Access denied: only Management / Admin can approve or decline expense requests.");
  }
  const state = loadStore();
  const req = state.expenseRequests.find((r) => r.id === requestId);
  if (!req) throw new Error("Expense request not found.");
  assertBusinessBoundary(session, req.businessId, "expense request");
  req.status = decision;
  req.reviewedBy = session.email;
  req.reviewComment = comment.trim();
  saveStore(state);
}

export async function recordOrMatchTransfer(
  session: AuthSession,
  input: {
    transferDate: string;
    fromAccountId: string | null;
    toAccountId: string;
    amountCents: number;
    sharedReference: string;
    description: string;
    transferKind: CashTransferRecord["transferKind"];
    note: string;
  },
): Promise<{ transfer: CashTransferRecord; matchedExisting: boolean }> {
  if (!can(session.role, "loans.view")) {
    throw new Error("Access denied: Supervisors cannot record or match cash transfers.");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Transfer amount must be a positive ZAR value.");
  }
  if (!input.sharedReference.trim()) {
    throw new Error("Enter a shared transfer reference so Admin and Owner records can be matched.");
  }

  const state = loadStore();
  const normRef = input.sharedReference.trim().toLowerCase();
  const now = new Date().toISOString();

  // Check for an existing pending_match transfer with same reference & amount from the other party (T14)
  const existing = state.transfers.find(
    (t) =>
      t.businessId === session.businessId &&
      t.status === "pending_match" &&
      t.sharedReference.trim().toLowerCase() === normRef &&
      t.amountCents === input.amountCents,
  );

  const postTransferJournal = (t: CashTransferRecord): JournalEntry => {
    const toAcc = state.accounts.find((a) => a.id === t.toAccountId);
    if (!toAcc) throw new Error("Destination account not found.");

    let creditAcc: LedgerAccount;
    let sourceType: JournalSourceType = "transfer";
    if (t.transferKind === "internal_transfer") {
      const fromAcc = state.accounts.find((a) => a.id === t.fromAccountId);
      if (!fromAcc) throw new Error("Source account is required for internal transfers.");
      creditAcc = fromAcc;
    } else if (t.transferKind === "lender_advance") {
      creditAcc = findAccountByType(state, session.businessId, "loan_liability");
      sourceType = "loan_advance";
    } else if (t.transferKind === "restricted_grant") {
      creditAcc = findAccountByType(state, session.businessId, "restricted_grant_income");
      sourceType = "grant_receipt";
    } else {
      creditAcc = findAccountByType(state, session.businessId, "owner_equity");
      sourceType = "owner_contribution";
    }

    const je = appendBalancedJournalEntry(state, {
      businessId: session.businessId,
      entryDate: t.transferDate,
      sourceType,
      sourceId: t.id,
      jobId: null,
      reference: t.sharedReference,
      description: t.description || `Matched ${t.transferKind.replace(/_/g, " ")}`,
      evidenceStatus: "verified",
      lines: [
        {
          id: newId(),
          accountId: toAcc.id,
          accountType: toAcc.accountType,
          debitCents: t.amountCents,
          creditCents: 0,
          memo: `Inflow to ${toAcc.name}`,
        },
        {
          id: newId(),
          accountId: creditAcc.id,
          accountType: creditAcc.accountType,
          debitCents: 0,
          creditCents: t.amountCents,
          memo: `Contra: ${creditAcc.name}`,
        },
      ],
      createdBy: session.email,
    });

    if (t.transferKind === "lender_advance") {
      const mainLoan = state.loans.find((l) => l.businessId === session.businessId);
      if (mainLoan && !state.loanEvents.some((ev) => ev.journalEntryId === je.id)) {
        state.loanEvents.unshift({
          id: newId(),
          businessId: session.businessId,
          loanId: mainLoan.id,
          eventDate: t.transferDate,
          eventType: "advance",
          amountCents: t.amountCents,
          accountId: toAcc.id,
          usedRestrictedFunding: false,
          restrictedEligibilityApproved: false,
          reference: t.sharedReference,
          note: t.description || "Matched lender advance",
          evidenceStatus: "verified",
          journalEntryId: je.id,
          recordedBy: session.email,
          createdAt: now,
        });
      }
    }

    return je;
  };

  if (existing) {
    if (session.role === "admin" && !existing.reportedByAdmin) {
      existing.reportedByAdmin = { userId: session.email, note: input.note.trim(), recordedAt: now };
    } else if (session.role === "owner" && !existing.confirmedByOwner) {
      existing.confirmedByOwner = { userId: session.email, note: input.note.trim(), recordedAt: now };
    } else {
      throw new Error("Your side of this transfer reference has already been recorded.");
    }

    if (existing.reportedByAdmin && existing.confirmedByOwner) {
      existing.status = "matched";
      const je = postTransferJournal(existing);
      existing.journalEntryId = je.id;
    }
    saveStore(state);
    return { transfer: existing, matchedExisting: true };
  }

  const toAcc = state.accounts.find((a) => a.id === input.toAccountId && a.businessId === session.businessId);
  if (!toAcc || !toAcc.isCashAccount) throw new Error("Select a valid destination cash/bank account.");
  if (input.transferKind === "restricted_grant" && !toAcc.isRestricted) {
    throw new Error("Restricted grants must be deposited into a restricted funding account.");
  }

  const transfer: CashTransferRecord = {
    id: newId(),
    businessId: session.businessId,
    transferDate: input.transferDate,
    fromAccountId: input.transferKind === "internal_transfer" ? input.fromAccountId : null,
    toAccountId: toAcc.id,
    amountCents: input.amountCents,
    sharedReference: input.sharedReference.trim(),
    description: input.description.trim(),
    transferKind: input.transferKind,
    reportedByAdmin:
      session.role === "admin" ? { userId: session.email, note: input.note.trim(), recordedAt: now } : null,
    confirmedByOwner:
      session.role === "owner" ? { userId: session.email, note: input.note.trim(), recordedAt: now } : null,
    status: "pending_match",
    journalEntryId: null,
    createdAt: now,
  };

  state.transfers.unshift(transfer);
  saveStore(state);
  return { transfer, matchedExisting: false };
}

export async function recordCashReconciliation(
  session: AuthSession,
  input: { accountId: string; reconciledDate: string; countedBalanceCents: number; note: string },
): Promise<CashReconciliation> {
  if (!can(session.role, "payroll.reconcile")) {
    throw new Error("Access denied: only Management / Admin can record cash reconciliations.");
  }
  const state = loadStore();
  const acc = state.accounts.find((a) => a.id === input.accountId && a.businessId === session.businessId);
  if (!acc) throw new Error("Account not found.");
  const bizEntries = state.journalEntries.filter((j) => j.businessId === session.businessId);
  const ledgerBalanceCents = computeAccountBalanceCents(acc, bizEntries);
  const rec: CashReconciliation = {
    id: newId(),
    businessId: session.businessId,
    accountId: acc.id,
    reconciledDate: input.reconciledDate,
    ledgerBalanceCents,
    countedBalanceCents: input.countedBalanceCents,
    differenceCents: input.countedBalanceCents - ledgerBalanceCents,
    note: input.note.trim(),
    recordedBy: session.email,
    createdAt: new Date().toISOString(),
  };
  state.reconciliations.unshift(rec);
  saveStore(state);
  return rec;
}

export async function recordCustomerMilestoneReceipt(
  session: AuthSession,
  input: { milestoneId: string; receivedDate: string; receivedAmountCents: number; accountId: string; reference: string },
): Promise<PaymentMilestone> {
  if (!can(session.role, "payroll.reconcile")) {
    throw new Error("Access denied: only Management / Admin can post customer receipts.");
  }
  if (!Number.isInteger(input.receivedAmountCents) || input.receivedAmountCents <= 0) {
    throw new Error("Received amount must be a positive ZAR value.");
  }
  const state = loadStore();
  const ms = state.milestones.find((m) => m.id === input.milestoneId && m.businessId === session.businessId);
  if (!ms) throw new Error("Payment milestone not found.");
  const acc = state.accounts.find((a) => a.id === input.accountId && a.businessId === session.businessId);
  if (!acc || !acc.isCashAccount) throw new Error("Select a valid cash or bank account.");
  const revAcc = findAccountByType(state, session.businessId, "customer_revenue");

  const receiptId = newId();
  const je = appendBalancedJournalEntry(state, {
    businessId: session.businessId,
    entryDate: input.receivedDate,
    sourceType: "customer_receipt",
    sourceId: receiptId,
    jobId: ms.jobId,
    reference: input.reference.trim() || ms.reference,
    description: `Customer receipt: ${ms.label}`,
    evidenceStatus: "verified",
    lines: [
      {
        id: newId(),
        accountId: acc.id,
        accountType: acc.accountType,
        debitCents: input.receivedAmountCents,
        creditCents: 0,
        memo: "Customer receipt deposited",
      },
      {
        id: newId(),
        accountId: revAcc.id,
        accountType: revAcc.accountType,
        debitCents: 0,
        creditCents: input.receivedAmountCents,
        memo: "Contract receipt revenue",
      },
    ],
    createdBy: session.email,
  });

  ms.receivedAmountCents += input.receivedAmountCents;
  ms.receivedDate = input.receivedDate;
  ms.accountId = acc.id;
  ms.reference = input.reference.trim() || ms.reference;
  ms.journalEntryId = je.id;
  ms.status = ms.receivedAmountCents >= ms.expectedAmountCents ? "received" : "partial";
  saveStore(state);
  return ms;
}

export async function recordLoanEvent(
  session: AuthSession,
  input: {
    loanId: string;
    eventDate: string;
    eventType: LoanEventType;
    amountCents: number;
    accountId: string;
    restrictedEligibilityApproved: boolean;
    reference: string;
    note: string;
  },
): Promise<LoanEvent> {
  if (!can(session.role, "loans.edit")) {
    throw new Error("Access denied: only Management / Admin can record loan advances or repayments.");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Loan event amount must be a positive ZAR value.");
  }
  const state = loadStore();
  const loan = state.loans.find((l) => l.id === input.loanId && l.businessId === session.businessId);
  if (!loan) throw new Error("Loan account not found.");
  const acc = state.accounts.find((a) => a.id === input.accountId && a.businessId === session.businessId);
  if (!acc || !acc.isCashAccount) throw new Error("Select a valid cash/bank/funding account.");

  // T16 guard: restricted grant funds cannot be used for debt repayment unless explicitly eligible & approved
  if (acc.isRestricted && input.eventType === "repayment" && !input.restrictedEligibilityApproved) {
    throw new Error(
      "Restricted funding cannot be used for loan repayment unless eligibility is explicitly confirmed and approved.",
    );
  }

  const loanLiab = findAccountByType(state, session.businessId, "loan_liability");
  const eventId = newId();

  const lines: JournalLine[] =
    input.eventType === "advance"
      ? [
          { id: newId(), accountId: acc.id, accountType: acc.accountType, debitCents: input.amountCents, creditCents: 0, memo: "Loan advance received" },
          { id: newId(), accountId: loanLiab.id, accountType: loanLiab.accountType, debitCents: 0, creditCents: input.amountCents, memo: "Increase zero-interest loan principal" },
        ]
      : [
          { id: newId(), accountId: loanLiab.id, accountType: loanLiab.accountType, debitCents: input.amountCents, creditCents: 0, memo: "Reduce zero-interest loan principal (not operating expense)" },
          { id: newId(), accountId: acc.id, accountType: acc.accountType, debitCents: 0, creditCents: input.amountCents, memo: "Loan repayment outflow" },
        ];

  const je = appendBalancedJournalEntry(state, {
    businessId: session.businessId,
    entryDate: input.eventDate,
    sourceType: input.eventType === "advance" ? "loan_advance" : "loan_repayment",
    sourceId: eventId,
    jobId: null,
    reference: input.reference.trim() || `LOAN-${input.eventDate}`,
    description: `${input.eventType === "advance" ? "Loan advance" : "Loan repayment"} — ${loan.lenderName}`,
    evidenceStatus: "verified",
    lines,
    createdBy: session.email,
  });

  const ev: LoanEvent = {
    id: eventId,
    businessId: session.businessId,
    loanId: loan.id,
    eventDate: input.eventDate,
    eventType: input.eventType,
    amountCents: input.amountCents,
    accountId: acc.id,
    usedRestrictedFunding: acc.isRestricted,
    restrictedEligibilityApproved: acc.isRestricted && input.restrictedEligibilityApproved,
    reference: input.reference.trim(),
    note: input.note.trim(),
    evidenceStatus: "verified",
    journalEntryId: je.id,
    recordedBy: session.email,
    createdAt: new Date().toISOString(),
  };
  state.loanEvents.unshift(ev);
  saveStore(state);
  return ev;
}

export async function recordRestrictedGrantReceipt(
  session: AuthSession,
  input: { receiptDate: string; amountCents: number; reference: string; description: string },
): Promise<JournalEntry> {
  if (!can(session.role, "loans.edit")) {
    throw new Error("Access denied: only Management / Admin can record grant receipts.");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Grant amount must be a positive ZAR value.");
  }
  const state = loadStore();
  const restrictedAcc = findAccountByType(state, session.businessId, "restricted_funding");
  const grantIncAcc = findAccountByType(state, session.businessId, "restricted_grant_income");
  const je = appendBalancedJournalEntry(state, {
    businessId: session.businessId,
    entryDate: input.receiptDate,
    sourceType: "grant_receipt",
    sourceId: newId(),
    jobId: null,
    reference: input.reference.trim() || `GRANT-${input.receiptDate}`,
    description: input.description.trim() || "Restricted grant funding received",
    evidenceStatus: "verified",
    lines: [
      { id: newId(), accountId: restrictedAcc.id, accountType: restrictedAcc.accountType, debitCents: input.amountCents, creditCents: 0, memo: "Restricted grant inflow" },
      { id: newId(), accountId: grantIncAcc.id, accountType: grantIncAcc.accountType, debitCents: 0, creditCents: input.amountCents, memo: "Restricted grant funding" },
    ],
    createdBy: session.email,
  });
  saveStore(state);
  return je;
}

export async function setLoanOpeningVerified(
  session: AuthSession,
  loanId: string,
  verified: boolean,
): Promise<void> {
  if (!can(session.role, "loans.edit")) {
    throw new Error("Access denied: only Management / Admin can verify loan principal.");
  }
  const state = loadStore();
  const loan = state.loans.find((l) => l.id === loanId && l.businessId === session.businessId);
  if (!loan) throw new Error("Loan account not found.");
  loan.openingPrincipalVerified = verified;
  saveStore(state);
}