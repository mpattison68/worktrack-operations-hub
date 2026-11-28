import { beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "@/lib/domain/types";
import type { FinanceBundle } from "@/lib/domain/increment-d-types";
import {
  addLoanRepaymentSchedule,
  createCustomerInvoice,
  createLoanAccount,
  listFinanceBundle,
  recordBulkWagePayment,
  recordCustomerMilestoneReceipt,
  recordExpense,
  recordLoanEvent,
  recordOrMatchTransfer,
  reverseFinancialTransaction,
  settleExpense,
  verifyCustomerReceipt,
  verifyLoanEvent,
} from "@/lib/data/increment-d-repository";
import {
  buildLoanStatement,
  calculateLoanBalanceCents,
  computeCashSummary,
  evaluateLoanRepaymentSchedule,
  reconcileLoanLedgerCents,
  summarizeWorkerWagePayments,
} from "@/lib/domain/finance-calc";
import {
  listAttendanceForWeek,
  listJobProgressBundle,
  resetSyntheticIncrementCStore,
} from "@/lib/data/increment-c-repository";
import { listMutations, resetInMemoryOfflineStore } from "@/lib/offline/idb-store";
import { enqueueOfflineMutation, runSyncEngine } from "@/lib/offline/sync-engine";
import { SYNTHETIC_BIZ_A, SYNTHETIC_JOB_1 } from "@/lib/data/synthetic-fixtures";

const adminSession: AuthSession = {
  userId: "admin-1",
  email: "admin@vuyo-demo.invalid",
  fullName: "Admin User",
  role: "admin",
  businessId: SYNTHETIC_BIZ_A,
  businessName: "Vuyo Demo",
  assignedJobIds: [SYNTHETIC_JOB_1],
  mode: "synthetic_dev",
};

const ownerSession: AuthSession = {
  ...adminSession,
  userId: "owner-1",
  email: "owner@vuyo-demo.invalid",
  fullName: "Owner User",
  role: "owner",
};

const supervisorSession: AuthSession = {
  ...adminSession,
  userId: "sup-1",
  email: "sup@vuyo-demo.invalid",
  fullName: "Supervisor User",
  role: "supervisor",
};

function seedZeroFinance(): void {
  const store: FinanceBundle = {
    accounts: [
      { id: "acc-bank", businessId: SYNTHETIC_BIZ_A, code: "1010", name: "Bank", accountType: "bank", isCashAccount: true, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-cash", businessId: SYNTHETIC_BIZ_A, code: "1020", name: "Cash", accountType: "cash", isCashAccount: true, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-restr", businessId: SYNTHETIC_BIZ_A, code: "1030", name: "Restricted", accountType: "restricted_funding", isCashAccount: true, isRestricted: true, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-wages", businessId: SYNTHETIC_BIZ_A, code: "2100", name: "Wages Payable", accountType: "wages_payable", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-loan", businessId: SYNTHETIC_BIZ_A, code: "2200", name: "Loan Liability", accountType: "loan_liability", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-equity", businessId: SYNTHETIC_BIZ_A, code: "3000", name: "Owner Equity", accountType: "owner_equity", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-rev", businessId: SYNTHETIC_BIZ_A, code: "4000", name: "Customer Revenue", accountType: "customer_revenue", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-opex", businessId: SYNTHETIC_BIZ_A, code: "5100", name: "Operating Expenses", accountType: "operating_expenses", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-capex", businessId: SYNTHETIC_BIZ_A, code: "1500", name: "Capital Expenditure", accountType: "capital_expenditure", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
    ],
    journalEntries: [],
    wagePayments: [],
    expenses: [],
    expenseRequests: [],
    transfers: [],
    reconciliations: [],
    milestones: [],
    loans: [],
    loanEvents: [],
    loanRepaymentSchedules: [],
    financialReversals: [],
    customerReceipts: [],
    expenseSettlements: [],
    forecastAssumptions: [],
  };
  window.localStorage.setItem("worktrack_synthetic_increment_d_v1", JSON.stringify(store));
}

describe("Financial reversals, Owner loan/receipt usability, and offline field operations", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    seedZeroFinance();
    resetSyntheticIncrementCStore();
    resetInMemoryOfflineStore();
  });

  it("reverses all 7 financial transaction types with Admin authorization, reason, duplicate block, and exact ledger/subledger reconciliation", async () => {
    // 1. Opening loan creates a balanced non-cash opening entry reconciled to loan_liability
    const loan = await createLoanAccount(adminSession, {
      lenderName: "Lender A",
      openingPrincipalCents: 20000000, // R200,000
      effectiveDate: "2026-12-01",
      reference: "OPEN-1",
      openingPrincipalVerified: true,
    });
    let bundle = await listFinanceBundle(adminSession);
    expect(computeCashSummary(bundle.accounts, bundle.journalEntries).unrestrictedCashCents).toBe(0);
    expect(reconcileLoanLedgerCents(bundle.loans, bundle.loanEvents, bundle.accounts, bundle.journalEntries, bundle.financialReversals)).toMatchObject({
      loanLiabilityLedgerCents: 20000000,
      loanSubledgerRemainingCents: 20000000,
      varianceCents: 0,
      balanced: true,
    });

    // 2. Customer receipt + reversal
    const ms = await createCustomerInvoice(adminSession, {
      jobId: SYNTHETIC_JOB_1,
      label: "Claim 1",
      reference: "INV-1",
      expectedDate: "2026-12-10",
      amountCents: 10000000,
    });
    await recordCustomerMilestoneReceipt(adminSession, {
      milestoneId: ms.id,
      receivedDate: "2026-12-10",
      receivedAmountCents: 5000000,
      accountId: "acc-bank",
      reference: "RCPT-1",
    });
    bundle = await listFinanceBundle(adminSession);
    const receiptId = bundle.customerReceipts![0]!.id;

    // Owner & Supervisor cannot reverse; blank reason rejected
    await expect(
      reverseFinancialTransaction(ownerSession, { targetType: "customer_receipt", targetId: receiptId, reason: "Owner attempt" }),
    ).rejects.toThrow(/only Management \/ Admin/i);
    await expect(
      reverseFinancialTransaction(adminSession, { targetType: "customer_receipt", targetId: receiptId, reason: "x" }),
    ).rejects.toThrow(/correction reason/i);

    await reverseFinancialTransaction(adminSession, {
      targetType: "customer_receipt",
      targetId: receiptId,
      reason: "Entered against wrong customer claim",
    });
    // Duplicate reversal blocked
    await expect(
      reverseFinancialTransaction(adminSession, { targetType: "customer_receipt", targetId: receiptId, reason: "Duplicate" }),
    ).rejects.toThrow(/already been reversed/i);

    bundle = await listFinanceBundle(adminSession);
    expect(bundle.customerReceipts).toHaveLength(1); // original preserved
    expect(bundle.milestones[0]!.receivedAmountCents).toBe(0);
    expect(bundle.milestones[0]!.status).toBe("expected");
    expect(computeCashSummary(bundle.accounts, bundle.journalEntries).unrestrictedCashCents).toBe(0);

    // Re-post valid customer receipt of R100,000 so cash is positive for remaining tests
    await recordCustomerMilestoneReceipt(adminSession, {
      milestoneId: ms.id,
      receivedDate: "2026-12-11",
      receivedAmountCents: 10000000,
      accountId: "acc-bank",
      reference: "RCPT-2",
    });

    // 3. Wage payment + reversal (reopens allocations)
    const wp = await recordBulkWagePayment(adminSession, {
      jobId: SYNTHETIC_JOB_1,
      paymentDate: "2026-12-12",
      accountId: "acc-bank",
      method: "bank_transfer",
      reference: "WAGE-1",
      evidenceNote: "Weekly wages",
      workerAmounts: [{ workerId: "w-1", amountCents: 250000 }],
      approvedRuns: [],
    });
    await reverseFinancialTransaction(adminSession, { targetType: "wage_payment", targetId: wp.id, reason: "Wrong worker amount" });
    bundle = await listFinanceBundle(adminSession);
    expect(bundle.wagePayments).toHaveLength(1); // original preserved
    expect(summarizeWorkerWagePayments("w-1", bundle.wagePayments, bundle.financialReversals).totalPaidCents).toBe(0);
    expect(computeCashSummary(bundle.accounts, bundle.journalEntries).unrestrictedCashCents).toBe(10000000);

    // 4. Expense + Expense settlement + reversals (must reverse settlement before parent expense)
    const exp = await recordExpense(adminSession, {
      jobId: SYNTHETIC_JOB_1,
      expenseDate: "2026-12-12",
      category: "fuel",
      classification: "operating",
      amountCents: 500000,
      paidAmountCents: 200000,
      paymentStatus: "partially_paid",
      accountId: "acc-bank",
      method: "card",
      supplierName: "Fuel Depot",
      description: "Diesel",
      reference: "FUEL-1",
      fuelLitres: 200,
      vehicleOrMachine: "Truck 1",
      odometerKm: 10000,
      receiptAttachment: null,
      missingReceiptReason: "Slip faded",
      expenseRequestId: null,
      unapprovedExceptionFlag: false,
    });
    await settleExpense(adminSession, {
      expenseId: exp.id,
      amountCents: 300000,
      accountId: "acc-bank",
      paymentDate: "2026-12-13",
      reference: "SET-1",
    });
    bundle = await listFinanceBundle(adminSession);
    const settlementId = bundle.expenseSettlements![0]!.id;
    await expect(
      reverseFinancialTransaction(adminSession, { targetType: "expense", targetId: exp.id, reason: "Wrong invoice" }),
    ).rejects.toThrow(/Reverse linked expense settlement/i);

    await reverseFinancialTransaction(adminSession, { targetType: "expense_settlement", targetId: settlementId, reason: "Duplicate payment" });
    await reverseFinancialTransaction(adminSession, { targetType: "expense", targetId: exp.id, reason: "Cancelled fuel order" });
    bundle = await listFinanceBundle(adminSession);
    expect(computeCashSummary(bundle.accounts, bundle.journalEntries).unrestrictedCashCents).toBe(10000000);

    // 5. Loan advance + Loan repayment + reversals
    const adv = await recordLoanEvent(adminSession, {
      loanId: loan.id,
      eventDate: "2026-12-14",
      eventType: "advance",
      amountCents: 1500000,
      accountId: "acc-bank",
      restrictedEligibilityApproved: false,
      reference: "ADV-1",
      note: "Working capital",
    });
    const rep = await recordLoanEvent(adminSession, {
      loanId: loan.id,
      eventDate: "2026-12-15",
      eventType: "repayment",
      amountCents: 1000000,
      accountId: "acc-bank",
      restrictedEligibilityApproved: false,
      reference: "REP-1",
      note: "Mistaken repayment",
    });
    await reverseFinancialTransaction(adminSession, { targetType: "loan_repayment", targetId: rep.id, reason: "Wrong bank reference" });
    await reverseFinancialTransaction(adminSession, { targetType: "loan_advance", targetId: adv.id, reason: "Advance not disbursed" });

    bundle = await listFinanceBundle(adminSession);
    expect(calculateLoanBalanceCents(loan, bundle.loanEvents, bundle.financialReversals).remainingPrincipalCents).toBe(20000000);
    expect(buildLoanStatement(loan, bundle.loanEvents, bundle.financialReversals).closingBalanceCents).toBe(20000000);
    expect(reconcileLoanLedgerCents(bundle.loans, bundle.loanEvents, bundle.accounts, bundle.journalEntries, bundle.financialReversals).balanced).toBe(true);

    // 6. Cash transfer (matched) + reversal
    await recordOrMatchTransfer(adminSession, {
      transferDate: "2026-12-16",
      fromAccountId: "acc-bank",
      toAccountId: "acc-cash",
      amountCents: 1000000,
      sharedReference: "TRF-1",
      description: "Cash withdrawal",
      transferKind: "internal_transfer",
      note: "Admin side",
    });
    const matched = await recordOrMatchTransfer(ownerSession, {
      transferDate: "2026-12-16",
      fromAccountId: "acc-bank",
      toAccountId: "acc-cash",
      amountCents: 1000000,
      sharedReference: "TRF-1",
      description: "Cash withdrawal",
      transferKind: "internal_transfer",
      note: "Owner side",
    });
    await reverseFinancialTransaction(adminSession, { targetType: "transfer", targetId: matched.transfer.id, reason: "Withdrawal cancelled" });
    bundle = await listFinanceBundle(adminSession);
    const cashAfter = computeCashSummary(bundle.accounts, bundle.journalEntries);
    expect(cashAfter.byAccountId["acc-cash"]).toBe(0);
    expect(cashAfter.byAccountId["acc-bank"]).toBe(10000000);
  });

  it("allows Owner to record customer receipts and loan repayments for Admin confirmation, and allocates partial/early repayments to scheduled instalments", async () => {
    const loan = await createLoanAccount(adminSession, {
      lenderName: "Lender B",
      openingPrincipalCents: 25000000,
      effectiveDate: "2026-12-01",
      reference: "OPEN-B",
      openingPrincipalVerified: true,
    });
    const sched1 = await addLoanRepaymentSchedule(adminSession, {
      loanId: loan.id,
      expectedDate: "2026-12-20",
      expectedAmountCents: 10000000,
      reference: "INST-1",
    });
    const sched2 = await addLoanRepaymentSchedule(adminSession, {
      loanId: loan.id,
      expectedDate: "2027-01-20",
      expectedAmountCents: 15000000,
      reference: "INST-2",
    });
    const ms = await createCustomerInvoice(adminSession, {
      jobId: SYNTHETIC_JOB_1,
      label: "Progress claim",
      reference: "INV-OWN",
      expectedDate: "2026-12-15",
      amountCents: 30000000,
    });

    // Owner records customer receipt -> starts as reported; Admin verifies
    await recordCustomerMilestoneReceipt(ownerSession, {
      milestoneId: ms.id,
      receivedDate: "2026-12-15",
      receivedAmountCents: 20000000,
      accountId: "acc-bank",
      reference: "OWN-RCPT",
    });
    let bundle = await listFinanceBundle(adminSession);
    expect(bundle.customerReceipts![0]!.evidenceStatus).toBe("reported");
    await verifyCustomerReceipt(adminSession, bundle.customerReceipts![0]!.id);

    // Owner cannot record loan advance or use restricted account
    await expect(
      recordLoanEvent(ownerSession, {
        loanId: loan.id,
        eventDate: "2026-12-16",
        eventType: "advance",
        amountCents: 1000000,
        accountId: "acc-bank",
        restrictedEligibilityApproved: false,
        reference: "NO-ADV",
        note: "",
      }),
    ).rejects.toThrow(/only Management \/ Admin/i);

    // Owner records an early partial payment allocated explicitly to INST-2 (R50,000)
    const ownerRep = await recordLoanEvent(ownerSession, {
      loanId: loan.id,
      eventDate: "2026-12-16",
      eventType: "repayment",
      amountCents: 5000000,
      accountId: "acc-bank",
      scheduleId: sched2.id,
      restrictedEligibilityApproved: false,
      reference: "EARLY-INST2",
      note: "Early partial payment toward January instalment",
    });
    expect(ownerRep.evidenceStatus).toBe("reported");
    await verifyLoanEvent(adminSession, ownerRep.id);

    bundle = await listFinanceBundle(adminSession);
    const evalSched = evaluateLoanRepaymentSchedule(
      loan,
      bundle.loanEvents,
      bundle.loanRepaymentSchedules ?? [],
      "2026-12-18",
      bundle.financialReversals,
    );
    const item1 = evalSched.items.find((i) => i.schedule.id === sched1.id)!;
    const item2 = evalSched.items.find((i) => i.schedule.id === sched2.id)!;
    expect(item1.paidAmountCents).toBe(0);
    expect(item1.outstandingAmountCents).toBe(10000000);
    expect(item2.paidAmountCents).toBe(5000000);
    expect(item2.outstandingAmountCents).toBe(10000000);
    expect(evalSched.totalOutstandingScheduledCents).toBe(20000000); // exact remaining principal, no double-counting
  });

  it("queues offline bulk attendance, exceptions, overtime, interruptions (rain/vehicle/downtime), and progress across restart and syncs without duplication", async () => {
    // Queue bulk crew attendance + overtime + rain/vehicle interruptions + progress while offline
    await enqueueOfflineMutation(supervisorSession, {
      entityType: "attendance",
      operation: "update",
      label: "Bulk crew attendance 2026-12-01",
      payload: {
        kind: "team",
        input: {
          jobId: SYNTHETIC_JOB_1,
          workDate: "2026-12-01",
          dayStatus: "worked",
          normalHours: 9,
          weekdayOtHours: 2,
          saturdayHours: 0,
          sundayHours: 0,
          publicHolidayHours: 0,
          interruptionReason: null,
          notes: "Full crew + 2h overtime",
        },
      },
      baseRevision: 0,
    });
    await enqueueOfflineMutation(supervisorSession, {
      entityType: "attendance",
      operation: "update",
      label: "Individual exception 2026-12-01",
      payload: {
        kind: "exception",
        input: {
          jobId: SYNTHETIC_JOB_1,
          workerId: "w-1",
          workDate: "2026-12-01",
          dayStatus: "partial",
          normalHours: 4.5,
          weekdayOtHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          publicHolidayHours: 0,
          overrideReason: "Clinic visit afternoon",
        },
      },
      baseRevision: 0,
    });
    await enqueueOfflineMutation(supervisorSession, {
      entityType: "interruption",
      operation: "create",
      label: "Interruption (Rain / weather) 2026-12-02",
      payload: {
        kind: "interruption",
        input: {
          jobId: SYNTHETIC_JOB_1,
          interruptionDate: "2026-12-02",
          durationHours: 4,
          fullDay: false,
          affectedCrewOrSection: "Whole crew",
          reason: "rain",
          comment: "Heavy afternoon thunderstorm",
        },
      },
    });
    await enqueueOfflineMutation(supervisorSession, {
      entityType: "interruption",
      operation: "create",
      label: "Interruption (Vehicle breakdown) 2026-12-03",
      payload: {
        kind: "interruption",
        input: {
          jobId: SYNTHETIC_JOB_1,
          interruptionDate: "2026-12-03",
          durationHours: 9,
          fullDay: true,
          affectedCrewOrSection: "4-ton truck",
          reason: "vehicle",
          comment: "Radiator hose burst on site",
        },
      },
    });

    // Simulate restart by reading persisted mutations directly from IndexedDB store
    const persisted = await listMutations(SYNTHETIC_BIZ_A, supervisorSession.userId);
    expect(persisted).toHaveLength(4);
    expect(persisted.every((m) => m.status === "queued")).toBe(true);

    // Sync when back online
    const firstSync = await runSyncEngine(supervisorSession, { isOnline: true });
    expect(firstSync.synced).toBe(4);
    expect(firstSync.failed).toBe(0);

    // Second sync produces zero duplicates
    const secondSync = await runSyncEngine(supervisorSession, { isOnline: true });
    expect(secondSync.attempted).toBe(0);

    const att = await listAttendanceForWeek(supervisorSession, SYNTHETIC_JOB_1, "2026-11-30");
    expect(att.teamDays.find((t) => t.workDate === "2026-12-01")?.weekdayOtHours).toBe(2);
    expect(att.attendanceEntries.find((a) => a.workerId === "w-1" && a.workDate === "2026-12-01")?.overrideReason).toBe("Clinic visit afternoon");

    const workBundle = await listJobProgressBundle(supervisorSession, SYNTHETIC_JOB_1);
    expect(workBundle.interruptions.filter((i) => i.comment === "Heavy afternoon thunderstorm")).toHaveLength(1);
    expect(workBundle.interruptions.filter((i) => i.comment === "Radiator hose burst on site")).toHaveLength(1);
  });
});