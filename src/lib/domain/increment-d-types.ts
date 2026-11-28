export type AccountType =
  | "bank"
  | "cash"
  | "restricted_funding"
  | "wages_payable"
  | "operating_expenses"
  | "capital_expenditure"
  | "customer_revenue"
  | "loan_liability"
  | "owner_equity"
  | "restricted_grant_income";

export interface LedgerAccount {
  id: string;
  businessId: string;
  code: string;
  name: string;
  accountType: AccountType;
  isCashAccount: boolean;
  isRestricted: boolean;
  openingBalanceCents: number;
  openingBalanceVerified: boolean;
  active: boolean;
}

export type JournalSourceType =
  | "wage_payment"
  | "expense"
  | "expense_settlement"
  | "transfer"
  | "customer_receipt"
  | "loan_advance"
  | "loan_repayment"
  | "grant_receipt"
  | "owner_contribution"
  | "reversal";

export interface JournalLine {
  id: string;
  accountId: string;
  accountType: AccountType;
  debitCents: number;
  creditCents: number;
  memo: string;
}

export interface JournalEntry {
  id: string;
  businessId: string;
  entryDate: string; // YYYY-MM-DD
  sourceType: JournalSourceType;
  sourceId: string;
  jobId: string | null;
  reference: string;
  description: string;
  evidenceStatus: EvidenceStatus;
  reversalOfId: string | null;
  lines: JournalLine[];
  createdBy: string;
  createdAt: string;
}

export type PaymentMethod = "cash" | "bank_transfer" | "card" | "other";
export type EvidenceStatus = "reported" | "verified" | "disputed";

export interface WageAllocation {
  id: string;
  wagePaymentId: string;
  workerId: string;
  payrollRunId: string | null; // null = unallocated advance
  amountCents: number;
}

export interface WagePayment {
  id: string;
  businessId: string;
  jobId: string | null;
  paymentDate: string;
  accountId: string;
  method: PaymentMethod;
  reference: string;
  totalAmountCents: number;
  evidenceStatus: EvidenceStatus;
  evidenceNote: string;
  journalEntryId: string;
  allocations: WageAllocation[];
  recordedBy: string;
  verifiedBy: string | null;
  createdAt: string;
}

export type ExpenseCategory =
  | "fuel"
  | "food_water"
  | "wages"
  | "equipment_purchase"
  | "equipment_hire"
  | "equipment_repair"
  | "vehicle_hire"
  | "vehicle_repair"
  | "vehicle_service"
  | "vehicle_tyres"
  | "rent_storage"
  | "supplies"
  | "safety"
  | "transport"
  | "admin"
  | "other";

export type ExpenseClassification = "operating" | "capital";
export type ExpensePaymentStatus = "paid" | "unpaid_payable" | "partially_paid";

export interface ReceiptAttachmentMeta {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  capturedAt: string;
  dataUrlPreview?: string;
}

export interface ExpenseRecord {
  id: string;
  businessId: string;
  jobId: string | null; // null = business overhead
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
  fuelPricePerLitreCents: number | null;
  vehicleOrMachine: string;
  odometerKm: number | null;
  receiptAttachment: ReceiptAttachmentMeta | null;
  missingReceiptReason: string | null;
  needsReview: boolean;
  duplicateWarningFlag: boolean;
  expenseRequestId: string | null;
  unapprovedExceptionFlag: boolean;
  journalEntryId: string | null;
  evidenceStatus: EvidenceStatus;
  recordedBy: string;
  createdAt: string;
  revision?: number;
  idempotencyKey?: string;
}

export interface ExpenseRequest {
  id: string;
  businessId: string;
  jobId: string | null;
  category: ExpenseCategory;
  estimatedAmountCents: number;
  description: string;
  status: "pending" | "approved" | "declined";
  requestedBy: string;
  reviewedBy: string | null;
  reviewComment: string;
  createdAt: string;
}

export type TransferStatus = "pending_match" | "matched" | "disputed";

export interface CashTransferRecord {
  id: string;
  businessId: string;
  transferDate: string;
  fromAccountId: string | null; // null for external source (e.g. lender/owner)
  toAccountId: string;
  amountCents: number;
  sharedReference: string;
  description: string;
  transferKind: "internal_transfer" | "lender_advance" | "owner_contribution" | "restricted_grant";
  reportedByAdmin: { userId: string; note: string; recordedAt: string } | null;
  confirmedByOwner: { userId: string; note: string; recordedAt: string } | null;
  status: TransferStatus;
  journalEntryId: string | null;
  createdAt: string;
}

export interface CashReconciliation {
  id: string;
  businessId: string;
  accountId: string;
  reconciledDate: string;
  ledgerBalanceCents: number;
  countedBalanceCents: number;
  differenceCents: number;
  note: string;
  recordedBy: string;
  createdAt: string;
}

export interface PaymentMilestone {
  id: string;
  businessId: string;
  jobId: string;
  label: string;
  expectedDate: string;
  expectedAmountCents: number;
  receivedAmountCents: number;
  receivedDate: string | null;
  status: "expected" | "partial" | "received";
  accountId: string | null;
  reference: string;
  journalEntryId: string | null;
}

export interface LoanAccount {
  id: string;
  businessId: string;
  lenderName: string;
  openingPrincipalCents: number;
  openingPrincipalVerified: boolean;
  effectiveDate?: string; // YYYY-MM-DD
  reference?: string;
  notes?: string;
  interestRatePercent: 0; // Explicitly R0 interest per spec
  securityAssetNote: string;
  repaymentTermsNote: string;
  createdAt: string;
}

export interface LoanRepaymentSchedule {
  id: string;
  businessId: string;
  loanId: string;
  expectedDate: string; // YYYY-MM-DD
  expectedAmountCents: number;
  reference: string;
  note: string;
  createdBy?: string | null;
  createdAt: string;
}

export type LoanEventType = "advance" | "repayment" | "agreed_adjustment";

export interface LoanEvent {
  id: string;
  businessId: string;
  loanId: string;
  eventDate: string;
  eventType: LoanEventType;
  amountCents: number;
  accountId: string;
  usedRestrictedFunding: boolean;
  restrictedEligibilityApproved: boolean;
  reference: string;
  note: string;
  evidenceStatus: EvidenceStatus;
  journalEntryId: string;
  recordedBy: string;
  createdAt: string;
}

export interface WeeklyCashForecastInput {
  openingUnrestrictedCashCents: number;
  weeklyCashCostCents: number;
  weeksCount: number;
  startWeekDate: string; // Monday YYYY-MM-DD
  expectedReceipts: Array<{
    weekIndex: number; // 0-based week index
    amountCents: number;
    label: string;
  }>;
  scheduledLoanRepayments?: Array<{
    weekIndex: number;
    amountCents: number;
    label: string;
  }>;
  existingArrearsCents?: number; // included once in week 0 if provided
  receiptDelayWeeks?: number; // scenario shift
}

export interface WeeklyCashForecastRow {
  weekIndex: number;
  weekStartDate: string;
  openingCashCents: number;
  expectedReceiptsCents: number;
  scheduledOutflowsCents: number;
  closingCashCents: number;
  shortfallCents: number; // positive when closingCashCents < 0
  notes: string[];
}

export interface WeeklyCashForecastResult {
  rows: WeeklyCashForecastRow[];
  earliestNegativeWeekIndex: number | null;
  earliestNegativeWeekDate: string | null;
  peakShortfallCents: number;
  minimumClosingCashCents: number;
}

export interface FinanceBundle {
  accounts: LedgerAccount[];
  journalEntries: JournalEntry[];
  wagePayments: WagePayment[];
  expenses: ExpenseRecord[];
  expenseRequests: ExpenseRequest[];
  transfers: CashTransferRecord[];
  reconciliations: CashReconciliation[];
  milestones: PaymentMilestone[];
  loans: LoanAccount[];
  loanEvents: LoanEvent[];
  loanRepaymentSchedules?: LoanRepaymentSchedule[];
  customerReceipts?: CustomerReceipt[];
  expenseSettlements?: ExpenseSettlement[];
  forecastAssumptions?: ForecastAssumption[];
  fundingReceipts?: Array<{id:string;businessId:string;receiptDate:string;amountCents:number;accountId:string;journalEntryId:string;reference:string;recordedBy:string;createdAt:string}>;
}
export interface CustomerReceipt {
 id:string;businessId:string;milestoneId:string;jobId:string;receiptDate:string;amountCents:number;accountId:string;reference:string;journalEntryId:string;recordedBy:string;createdAt:string;
}
export interface ExpenseSettlement {
 id:string;businessId:string;expenseId:string;paymentDate:string;amountCents:number;accountId:string;reference:string;journalEntryId:string;recordedBy:string;createdAt:string;
}
export interface ForecastAssumption {
 id:string;businessId:string;jobId:string;weeklyCashCostCents:number;existingArrearsCents:number;receiptDelayWeeks:number;notes:string;updatedAt:string;
}
