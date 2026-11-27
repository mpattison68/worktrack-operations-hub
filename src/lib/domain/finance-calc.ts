import type {
  AccountType,
  ExpenseRecord,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  LoanAccount,
  LoanEvent,
  WageAllocation,
  WagePayment,
  WeeklyCashForecastInput,
  WeeklyCashForecastResult,
  WeeklyCashForecastRow,
} from "@/lib/domain/increment-d-types";
import type { PayrollRun } from "@/lib/domain/increment-c-types";

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
): {
  allocatedByRunId: Record<string, number>;
  unallocatedAdvanceCents: number;
  totalPaidCents: number;
} {
  const allocatedByRunId: Record<string, number> = {};
  let unallocatedAdvanceCents = 0;
  let totalPaidCents = 0;

  for (const payment of payments) {
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
): {
  openingPrincipalCents: number;
  totalAdvancesCents: number;
  totalRepaymentsCents: number;
  totalAdjustmentsCents: number;
  remainingPrincipalCents: number;
} {
  let totalAdvancesCents = 0;
  let totalRepaymentsCents = 0;
  let totalAdjustmentsCents = 0;

  for (const ev of events) {
    if (ev.loanId !== loan.id) continue;
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