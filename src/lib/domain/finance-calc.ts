import type {
  AccountType,
  ExpenseRecord,
  FinancialReversal,
  FinancialReversalTargetType,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  LoanAccount,
  LoanEvent,
  LoanRepaymentSchedule,
  PaymentMilestone,
  WageAllocation,
  WagePayment,
  WeeklyCashForecastInput,
  WeeklyCashForecastResult,
  WeeklyCashForecastRow,
} from "@/lib/domain/increment-d-types";

/**
 * Return the set of reversed target IDs for one or more transaction types.
 */
export function getReversedTargetIds(
  reversals: FinancialReversal[] | undefined,
  targetTypes: FinancialReversalTargetType | FinancialReversalTargetType[],
): Set<string> {
  const types = Array.isArray(targetTypes) ? targetTypes : [targetTypes];
  const set = new Set<string>();
  for (const r of reversals ?? []) {
    if (types.includes(r.targetType)) {
      set.add(r.targetId);
    }
  }
  return set;
}
import type { PayrollRun } from "@/lib/domain/increment-c-types";
import type { Job } from "@/lib/domain/types";

/**
 * Verify that a set of journal lines is strictly balanced in integer cents
 * (total debits === total credits > 0) with no negative or non-integer amounts.
 */
export function validateBalancedJournalLines(lines: JournalLine[]): string | null {
  if (lines.length < 2) {
    return "A journal entry must have at least two lines.";
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.debitCents) || !Number.isInteger(line.creditCents)) {
      return "All journal amounts must be integer ZAR cents.";
    }
    if (line.debitCents < 0 || line.creditCents < 0) {
      return "Journal debit/credit amounts cannot be negative.";
    }
    if (line.debitCents > 0 && line.creditCents > 0) {
      return "A journal line cannot have both debit and credit values.";
    }
    totalDebit += line.debitCents;
    totalCredit += line.creditCents;
  }
  if (totalDebit <= 0) {
    return "Journal entry total must be positive.";
  }
  if (totalDebit !== totalCredit) {
    return `Journal entry is unbalanced (debits ${totalDebit} != credits ${totalCredit}).`;
  }
  return null;
}

/**
 * Compute account balance in integer cents from opening balance + posted journal lines.
 * Asset & expense accounts have normal DEBIT balance (+debit -credit).
 * Liability, revenue & equity accounts have normal CREDIT balance (+credit -debit).
 */
export function isNormalDebitAccount(type: AccountType): boolean {
  return (
    type === "bank" ||
    type === "cash" ||
    type === "restricted_funding" ||
    type === "operating_expenses" ||
    type === "capital_expenditure"
  );
}

export function computeAccountBalanceCents(
  account: LedgerAccount,
  entries: JournalEntry[],
): number {
  let balance = account.openingBalanceCents;
  const normalDebit = isNormalDebitAccount(account.accountType);
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.accountId !== account.id) continue;
      balance += normalDebit
        ? line.debitCents - line.creditCents
        : line.creditCents - line.debitCents;
    }
  }
  return balance;
}

/**
 * Compute unrestricted cash vs restricted funding balances separately (T16).
 * Restricted grants are never included in unrestricted cash.
 */
export function computeCashSummary(
  accounts: LedgerAccount[],
  entries: JournalEntry[],
): {
  unrestrictedCashCents: number;
  restrictedCashCents: number;
  totalCashCents: number;
  byAccountId: Record<string, number>;
} {
  const byAccountId: Record<string, number> = {};
  let unrestrictedCashCents = 0;
  let restrictedCashCents = 0;

  for (const acc of accounts) {
    const bal = computeAccountBalanceCents(acc, entries);
    byAccountId[acc.id] = bal;
    if (acc.isCashAccount) {
      if (acc.isRestricted) {
        restrictedCashCents += bal;
      } else {
        unrestrictedCashCents += bal;
      }
    }
  }

  return {
    unrestrictedCashCents,
    restrictedCashCents,
    totalCashCents: unrestrictedCashCents + restrictedCashCents,
    byAccountId,
  };
}

/**
 * Allocate a worker's wage payment across their oldest unpaid approved payroll runs (T13).
 * Any unapplied remainder becomes an advance (payrollRunId = null).
 * Never allocates more than the payment amount.
 */
export function allocateWorkerWagePayment(params: {
  wagePaymentId: string;
  workerId: string;
  paymentAmountCents: number;
  approvedRuns: PayrollRun[];
  existingAllocations: WageAllocation[];
  preferredRunId?: string | null;
}): WageAllocation[] {
  const {
    wagePaymentId,
    workerId,
    paymentAmountCents,
    approvedRuns,
    existingAllocations,
    preferredRunId,
  } = params;

  if (!Number.isInteger(paymentAmountCents) || paymentAmountCents <= 0) {
    throw new Error("Wage payment amount must be a positive integer ZAR cent value.");
  }

  const alreadyPaidByRun = new Map<string, number>();
  for (const alloc of existingAllocations) {
    if (alloc.workerId !== workerId || !alloc.payrollRunId) continue;
    alreadyPaidByRun.set(
      alloc.payrollRunId,
      (alreadyPaidByRun.get(alloc.payrollRunId) ?? 0) + alloc.amountCents,
    );
  }

  const eligibleRuns = approvedRuns
    .filter((r) => r.status === "approved")
    .sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));

  if (preferredRunId) {
    eligibleRuns.sort((a, b) => {
      if (a.id === preferredRunId) return -1;
      if (b.id === preferredRunId) return 1;
      return a.weekStartDate.localeCompare(b.weekStartDate);
    });
  }

  let remaining = paymentAmountCents;
  const result: WageAllocation[] = [];
  let seq = 0;

  for (const run of eligibleRuns) {
    if (remaining <= 0) break;
    const line = run.earnings.find((e) => e.workerId === workerId);
    if (!line || line.netPayCents <= 0) continue;
    const alreadyPaid = alreadyPaidByRun.get(run.id) ?? 0;
    const unpaid = Math.max(0, line.netPayCents - alreadyPaid);
    if (unpaid <= 0) continue;
    const applied = Math.min(remaining, unpaid);
    result.push({
      id: `${wagePaymentId}-${workerId}-alloc-${++seq}`,
      wagePaymentId,
      workerId,
      payrollRunId: run.id,
      amountCents: applied,
    });
    remaining -= applied;
  }

  // Any remainder is recorded as an unallocated advance (reduces worker balance into negative/credit)
  if (remaining > 0) {
    result.push({
      id: `${wagePaymentId}-${workerId}-alloc-${++seq}`,
      wagePaymentId,
      workerId,
      payrollRunId: null,
      amountCents: remaining,
    });
  }

  return result;
}

/**
 * Aggregate allocated payments per run and unallocated advances for a given worker.
 */
export function summarizeWorkerWagePayments(
  workerId: string,
  payments: WagePayment[],
  reversals?: FinancialReversal[],
): {
  allocatedByRunId: Record<string, number>;
  unallocatedAdvanceCents: number;
  totalPaidCents: number;
} {
  const reversedIds = getReversedTargetIds(reversals, "wage_payment");
  const allocatedByRunId: Record<string, number> = {};
  let unallocatedAdvanceCents = 0;
  let totalPaidCents = 0;

  for (const payment of payments) {
    if (reversedIds.has(payment.id)) continue;
    for (const alloc of payment.allocations) {
      if (alloc.workerId !== workerId) continue;
      totalPaidCents += alloc.amountCents;
      if (alloc.payrollRunId) {
        allocatedByRunId[alloc.payrollRunId] =
          (allocatedByRunId[alloc.payrollRunId] ?? 0) + alloc.amountCents;
      } else {
        unallocatedAdvanceCents += alloc.amountCents;
      }
    }
  }

  return { allocatedByRunId, unallocatedAdvanceCents, totalPaidCents };
}

/**
 * Compute remaining loan principal (T12, T15).
 * Zero interest, zero fees: opening principal + advances - repayments + agreed adjustments.
 */
export function calculateLoanBalanceCents(
  loan: LoanAccount,
  events: LoanEvent[],
  reversals?: FinancialReversal[],
): {
  openingPrincipalCents: number;
  totalAdvancesCents: number;
  totalRepaymentsCents: number;
  totalAdjustmentsCents: number;
  remainingPrincipalCents: number;
} {
  const reversedIds = getReversedTargetIds(reversals, ["loan_advance", "loan_repayment"]);
  let totalAdvancesCents = 0;
  let totalRepaymentsCents = 0;
  let totalAdjustmentsCents = 0;

  for (const ev of events) {
    if (ev.loanId !== loan.id) continue;
    if (reversedIds.has(ev.id)) continue;
    if (ev.eventType === "advance") {
      totalAdvancesCents += ev.amountCents;
    } else if (ev.eventType === "repayment") {
      totalRepaymentsCents += ev.amountCents;
    } else if (ev.eventType === "agreed_adjustment") {
      totalAdjustmentsCents += ev.amountCents;
    }
  }

  const remainingPrincipalCents = Math.max(
    0,
    loan.openingPrincipalCents + totalAdvancesCents - totalRepaymentsCents + totalAdjustmentsCents,
  );

  return {
    openingPrincipalCents: loan.openingPrincipalCents,
    totalAdvancesCents,
    totalRepaymentsCents,
    totalAdjustmentsCents,
    remainingPrincipalCents,
  };
}

export interface LoanStatementRow {
  id: string;
  date: string;
  type: "opening" | "advance" | "repayment" | "agreed_adjustment" | "reversal";
  reference: string;
  description: string;
  advanceCents: number;
  repaymentCents: number;
  adjustmentCents: number;
  runningBalanceCents: number;
  evidenceStatus: string;
}

export interface LoanStatement {
  loanId: string;
  lenderName: string;
  effectiveDate: string;
  reference: string;
  openingPrincipalCents: number;
  openingPrincipalVerified: boolean;
  totalAdvancesCents: number;
  totalRepaymentsCents: number;
  totalAdjustmentsCents: number;
  closingBalanceCents: number;
  rows: LoanStatementRow[];
}

/**
 * Build a chronological zero-interest loan statement with running principal balances.
 */
export function buildLoanStatement(
  loan: LoanAccount,
  events: LoanEvent[],
  reversals?: FinancialReversal[],
): LoanStatement {
  const reversalByTarget = new Map<string, FinancialReversal>();
  for (const r of reversals ?? []) {
    if (r.targetType === "loan_advance" || r.targetType === "loan_repayment") {
      reversalByTarget.set(r.targetId, r);
    }
  }
  const loanEvents = events
    .filter((ev) => ev.loanId === loan.id)
    .slice()
    .sort((a, b) =>
      a.eventDate.localeCompare(b.eventDate) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
    );

  let running = loan.openingPrincipalCents;
  let totalAdvancesCents = 0;
  let totalRepaymentsCents = 0;
  let totalAdjustmentsCents = 0;

  const effectiveDate = loan.effectiveDate || loan.createdAt.slice(0, 10);
  const rows: LoanStatementRow[] = [
    {
      id: `${loan.id}-opening`,
      date: effectiveDate,
      type: "opening",
      reference: loan.reference || "OPENING",
      description: loan.notes || "Opening zero-interest loan liability (no cash inflow)",
      advanceCents: 0,
      repaymentCents: 0,
      adjustmentCents: 0,
      runningBalanceCents: running,
      evidenceStatus: loan.openingPrincipalVerified ? "verified" : "unverified",
    },
  ];

  for (const ev of loanEvents) {
    const rev = reversalByTarget.get(ev.id);
    let advanceCents = 0;
    let repaymentCents = 0;
    let adjustmentCents = 0;
    if (ev.eventType === "advance") {
      advanceCents = ev.amountCents;
      if (!rev) totalAdvancesCents += ev.amountCents;
      running += ev.amountCents;
    } else if (ev.eventType === "repayment") {
      repaymentCents = ev.amountCents;
      if (!rev) totalRepaymentsCents += ev.amountCents;
      running = Math.max(0, running - ev.amountCents);
    } else if (ev.eventType === "agreed_adjustment") {
      adjustmentCents = ev.amountCents;
      if (!rev) totalAdjustmentsCents += ev.amountCents;
      running += ev.amountCents;
    }
    rows.push({
      id: ev.id,
      date: ev.eventDate,
      type: ev.eventType,
      reference: ev.reference || "—",
      description:
        ev.note ||
        (ev.eventType === "advance"
          ? "Additional loan advance"
          : ev.eventType === "repayment"
            ? "Loan principal repayment"
            : "Agreed principal adjustment"),
      advanceCents,
      repaymentCents,
      adjustmentCents,
      runningBalanceCents: running,
      evidenceStatus: rev ? "reversed" : ev.evidenceStatus,
    });
    if (rev) {
      if (ev.eventType === "advance") {
        running = Math.max(0, running - ev.amountCents);
      } else if (ev.eventType === "repayment") {
        running += ev.amountCents;
      }
      rows.push({
        id: `${ev.id}-rev`,
        date: rev.createdAt.slice(0, 10),
        type: "reversal",
        reference: `REV-${ev.reference || ev.eventDate}`,
        description: `Reversal: ${rev.reason}`,
        advanceCents: ev.eventType === "advance" ? -ev.amountCents : 0,
        repaymentCents: ev.eventType === "repayment" ? -ev.amountCents : 0,
        adjustmentCents: 0,
        runningBalanceCents: running,
        evidenceStatus: "verified",
      });
    }
  }

  return {
    loanId: loan.id,
    lenderName: loan.lenderName,
    effectiveDate,
    reference: loan.reference || "",
    openingPrincipalCents: loan.openingPrincipalCents,
    openingPrincipalVerified: loan.openingPrincipalVerified,
    totalAdvancesCents,
    totalRepaymentsCents,
    totalAdjustmentsCents,
    closingBalanceCents: Math.max(
      0,
      loan.openingPrincipalCents + totalAdvancesCents - totalRepaymentsCents + totalAdjustmentsCents,
    ),
    rows,
  };
}

export type RepaymentScheduleStatus = "paid" | "overdue" | "due" | "upcoming";

export interface EvaluatedRepaymentScheduleItem {
  schedule: LoanRepaymentSchedule;
  paidAmountCents: number;
  outstandingAmountCents: number;
  status: RepaymentScheduleStatus;
}

/**
 * Evaluate agreed repayment schedule installments against actual repayments posted to date.
 * Explicit instalment allocations (scheduleId) are applied first (supporting partial & early payments),
 * then unallocated repayments and any excess spill over chronologically (FIFO).
 * Total remaining scheduled outflows are capped at remaining loan principal to avoid double-counting.
 */
export function evaluateLoanRepaymentSchedule(
  loan: LoanAccount,
  events: LoanEvent[],
  schedules: LoanRepaymentSchedule[],
  asOfDate: string,
  reversals?: FinancialReversal[],
): {
  items: EvaluatedRepaymentScheduleItem[];
  totalScheduledCents: number;
  totalOutstandingScheduledCents: number;
  totalOverdueCents: number;
  overdueCount: number;
} {
  const reversedIds = getReversedTargetIds(reversals, ["loan_advance", "loan_repayment"]);
  const loanBalance = calculateLoanBalanceCents(loan, events, reversals);
  let remainingPrincipalCap = loanBalance.remainingPrincipalCents;

  const sorted = schedules
    .filter((s) => s.loanId === loan.id)
    .slice()
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.id.localeCompare(b.id));
  const scheduleIds = new Set(sorted.map((s) => s.id));

  // First pass: sum repayments explicitly allocated to a specific scheduled instalment
  const explicitBySchedule = new Map<string, number>();
  let unallocatedRepaymentPool = 0;
  for (const ev of events) {
    if (ev.loanId !== loan.id || ev.eventType !== "repayment" || reversedIds.has(ev.id)) continue;
    if (ev.scheduleId && scheduleIds.has(ev.scheduleId)) {
      explicitBySchedule.set(ev.scheduleId, (explicitBySchedule.get(ev.scheduleId) ?? 0) + ev.amountCents);
    } else {
      unallocatedRepaymentPool += ev.amountCents;
    }
  }

  // Cap explicit allocations at each instalment's expected amount; spill excess into FIFO pool
  const allocatedBySchedule = new Map<string, number>();
  for (const schedule of sorted) {
    const explicit = explicitBySchedule.get(schedule.id) ?? 0;
    const applied = Math.min(schedule.expectedAmountCents, explicit);
    allocatedBySchedule.set(schedule.id, applied);
    if (explicit > applied) {
      unallocatedRepaymentPool += explicit - applied;
    }
  }

  const items: EvaluatedRepaymentScheduleItem[] = [];
  let totalScheduledCents = 0;
  let totalOutstandingScheduledCents = 0;
  let totalOverdueCents = 0;
  let overdueCount = 0;

  for (const schedule of sorted) {
    totalScheduledCents += schedule.expectedAmountCents;
    const explicitPaid = allocatedBySchedule.get(schedule.id) ?? 0;
    const fifoTopUp = Math.min(schedule.expectedAmountCents - explicitPaid, unallocatedRepaymentPool);
    unallocatedRepaymentPool = Math.max(0, unallocatedRepaymentPool - fifoTopUp);
    const paidAmountCents = explicitPaid + fifoTopUp;

    const rawOutstanding = Math.max(0, schedule.expectedAmountCents - paidAmountCents);
    const outstandingAmountCents = Math.min(rawOutstanding, remainingPrincipalCap);
    remainingPrincipalCap = Math.max(0, remainingPrincipalCap - outstandingAmountCents);

    let status: RepaymentScheduleStatus = "upcoming";
    if (outstandingAmountCents === 0) {
      status = "paid";
    } else if (schedule.expectedDate < asOfDate) {
      status = "overdue";
      totalOverdueCents += outstandingAmountCents;
      overdueCount += 1;
    } else if (schedule.expectedDate === asOfDate) {
      status = "due";
    }

    totalOutstandingScheduledCents += outstandingAmountCents;
    items.push({ schedule, paidAmountCents, outstandingAmountCents, status });
  }

  return {
    items,
    totalScheduledCents,
    totalOutstandingScheduledCents,
    totalOverdueCents,
    overdueCount,
  };
}

/**
 * Reconcile the loan_liability general-ledger account against the sum of active loan subledger balances.
 */
export function reconcileLoanLedgerCents(
  loans: LoanAccount[],
  events: LoanEvent[],
  accounts: LedgerAccount[],
  journalEntries: JournalEntry[],
  reversals?: FinancialReversal[],
): {
  loanLiabilityLedgerCents: number;
  loanSubledgerRemainingCents: number;
  varianceCents: number;
  balanced: boolean;
} {
  const loanLiabilityLedgerCents = accounts
    .filter((a) => a.accountType === "loan_liability")
    .reduce((sum, a) => sum + computeAccountBalanceCents(a, journalEntries), 0);
  const loanSubledgerRemainingCents = loans.reduce(
    (sum, loan) => sum + calculateLoanBalanceCents(loan, events, reversals).remainingPrincipalCents,
    0,
  );
  const varianceCents = loanLiabilityLedgerCents - loanSubledgerRemainingCents;
  return {
    loanLiabilityLedgerCents,
    loanSubledgerRemainingCents,
    varianceCents,
    balanced: varianceCents === 0,
  };
}

/**
 * Summarize total agreed contract value, customer payments received, and remaining customer receivables.
 */
export function summarizeContractReceivables(
  jobs: Job[],
  milestones: PaymentMilestone[],
): {
  totalContractValueCents: number;
  totalMilestonesExpectedCents: number;
  totalCustomerReceivedCents: number;
  remainingContractReceivablesCents: number;
  remainingMilestoneReceivablesCents: number;
  byJob: Array<{
    jobId: string;
    jobName: string;
    customerName: string;
    contractReference: string;
    contractValueCents: number;
    receivedCents: number;
    remainingReceivablesCents: number;
  }>;
} {
  let totalContractValueCents = 0;
  let totalMilestonesExpectedCents = 0;
  let totalCustomerReceivedCents = 0;

  const byJob = jobs.map((job) => {
    const jobMilestones = milestones.filter((m) => m.jobId === job.id);
    const receivedCents = jobMilestones.reduce((s, m) => s + m.receivedAmountCents, 0);
    const expectedCents = jobMilestones.reduce((s, m) => s + m.expectedAmountCents, 0);
    const effectiveContract = Math.max(job.contractValueCents, expectedCents);
    totalContractValueCents += job.contractValueCents;
    totalMilestonesExpectedCents += expectedCents;
    totalCustomerReceivedCents += receivedCents;
    return {
      jobId: job.id,
      jobName: job.name,
      customerName: job.customerName,
      contractReference: job.contractReference,
      contractValueCents: job.contractValueCents,
      receivedCents,
      remainingReceivablesCents: Math.max(0, effectiveContract - receivedCents),
    };
  });

  const baselineTotal = Math.max(totalContractValueCents, totalMilestonesExpectedCents);
  return {
    totalContractValueCents,
    totalMilestonesExpectedCents,
    totalCustomerReceivedCents,
    remainingContractReceivablesCents: Math.max(0, baselineTotal - totalCustomerReceivedCents),
    remainingMilestoneReceivablesCents: Math.max(0, totalMilestonesExpectedCents - totalCustomerReceivedCents),
    byJob,
  };
}

/**
 * Detect potential duplicate expenses by matching date + amount (+ reference if supplied).
 */
export function findDuplicateExpense(
  candidate: { expenseDate: string; amountCents: number; reference: string },
  existing: ExpenseRecord[],
): ExpenseRecord | null {
  const normRef = candidate.reference.trim().toLowerCase();
  return (
    existing.find((e) => {
      if (e.expenseDate !== candidate.expenseDate || e.amountCents !== candidate.amountCents) {
        return false;
      }
      if (!normRef) return true;
      return e.reference.trim().toLowerCase() === normRef;
    }) ?? null
  );
}

/**
 * Compute fuel unit cost in cents/litre when litres > 0.
 */
export function calculateFuelUnitCostCents(amountCents: number, litres: number | null): number | null {
  if (!litres || litres <= 0) return null;
  return Math.round(amountCents / litres);
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Weekly cash shortfall forecast (T17).
 * Uses unrestricted opening cash only, projects weekly outflows & expected receipts
 * (with optional delay scenario), includes existing arrears once, and identifies
 * the earliest negative week and peak shortfall amount.
 */
export function calculateWeeklyCashForecast(
  input: WeeklyCashForecastInput,
): WeeklyCashForecastResult {
  const delay = Math.max(0, Math.floor(input.receiptDelayWeeks ?? 0));
  const weeksCount = Math.max(1, Math.min(26, Math.floor(input.weeksCount)));
  const rows: WeeklyCashForecastRow[] = [];

  let runningCash = input.openingUnrestrictedCashCents;
  let earliestNegativeWeekIndex: number | null = null;
  let earliestNegativeWeekDate: string | null = null;
  let minimumClosingCashCents = runningCash;

  for (let w = 0; w < weeksCount; w++) {
    const weekStartDate = addDaysIso(input.startWeekDate, w * 7);
    const openingCashCents = runningCash;
    const notes: string[] = [];

    let expectedReceiptsCents = 0;
    for (const r of input.expectedReceipts) {
      if (r.weekIndex + delay === w) {
        expectedReceiptsCents += r.amountCents;
        notes.push(`Receipt: ${r.label}`);
      }
    }

    let scheduledOutflowsCents = input.weeklyCashCostCents;
    if (w === 0 && input.existingArrearsCents && input.existingArrearsCents > 0) {
      scheduledOutflowsCents += input.existingArrearsCents;
      notes.push("Includes existing arrears once");
    }
    for (const rep of input.scheduledLoanRepayments ?? []) {
      if (rep.weekIndex === w) {
        scheduledOutflowsCents += rep.amountCents;
        notes.push(`Loan repayment: ${rep.label}`);
      }
    }

    const closingCashCents = openingCashCents + expectedReceiptsCents - scheduledOutflowsCents;
    const shortfallCents = closingCashCents < 0 ? Math.abs(closingCashCents) : 0;

    if (closingCashCents < 0 && earliestNegativeWeekIndex === null) {
      earliestNegativeWeekIndex = w;
      earliestNegativeWeekDate = weekStartDate;
    }
    if (closingCashCents < minimumClosingCashCents) {
      minimumClosingCashCents = closingCashCents;
    }

    rows.push({
      weekIndex: w,
      weekStartDate,
      openingCashCents,
      expectedReceiptsCents,
      scheduledOutflowsCents,
      closingCashCents,
      shortfallCents,
      notes,
    });

    runningCash = closingCashCents;
  }

  return {
    rows,
    earliestNegativeWeekIndex,
    earliestNegativeWeekDate,
    peakShortfallCents: minimumClosingCashCents < 0 ? Math.abs(minimumClosingCashCents) : 0,
    minimumClosingCashCents,
  };
}