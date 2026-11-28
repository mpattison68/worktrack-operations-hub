import { beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "@/lib/domain/types";
import type { PayrollRun } from "@/lib/domain/increment-c-types";
import {
  calculateLoanBalanceCents,
  calculateWeeklyCashForecast,
  computeCashSummary,
  summarizeWorkerWagePayments,
  validateBalancedJournalLines,
} from "@/lib/domain/finance-calc";
import {
  listFinanceBundle,
  recordBulkWagePayment,
  recordExpense,
  recordLoanEvent,
  recordOrMatchTransfer,
  recordRestrictedGrantReceipt,
} from "@/lib/data/increment-d-repository";
import { SYNTHETIC_BIZ_A, SYNTHETIC_JOB_1 } from "@/lib/data/synthetic-fixtures";

const adminSession: AuthSession = {
  userId: "u-admin",
  email: "admin@synthetic.worktrack",
  fullName: "Synthetic Admin",
  businessId: SYNTHETIC_BIZ_A,
  businessName: "Synthetic Biz",
  role: "admin",
  assignedJobIds: [],
  mode: "synthetic_dev",
};

const ownerSession: AuthSession = {
  ...adminSession,
  userId: "u-owner",
  email: "owner@synthetic.worktrack",
  fullName: "Synthetic Owner",
  role: "owner",
};

const supervisorSession: AuthSession = {
  ...adminSession,
  userId: "u-sup",
  email: "sup@synthetic.worktrack",
  fullName: "Synthetic Supervisor",
  role: "supervisor",
  assignedJobIds: [SYNTHETIC_JOB_1],
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("Increment D acceptance tests (T12–T17, T23)", () => {
  it("T12: R15,000 lender advance increases cash and loan debt; worker arrears unchanged", async () => {
    const before = await listFinanceBundle(adminSession);
    const cashBefore = computeCashSummary(before.accounts, before.journalEntries).unrestrictedCashCents;
    const loanBefore = calculateLoanBalanceCents(before.loans[0]!, before.loanEvents).remainingPrincipalCents;

    await recordLoanEvent(adminSession, {
      loanId: before.loans[0]!.id,
      eventDate: "2026-11-27",
      eventType: "advance",
      amountCents: 1500000, // R 15 000.00
      accountId: "acc-bank-a",
      restrictedEligibilityApproved: false,
      reference: "ADV-01",
      note: "Lender working-capital advance",
    });

    const after = await listFinanceBundle(adminSession);
    const cashAfter = computeCashSummary(after.accounts, after.journalEntries).unrestrictedCashCents;
    const loanAfter = calculateLoanBalanceCents(after.loans[0]!, after.loanEvents).remainingPrincipalCents;

    expect(cashAfter - cashBefore).toBe(1500000);
    expect(loanAfter - loanBefore).toBe(1500000);
    expect(after.wagePayments).toHaveLength(0);
    expect(after.journalEntries.every((je) => validateBalancedJournalLines(je.lines) === null)).toBe(true);
  });

  it("T13: R9,120 paid to 12 workers + R500 cook creates exactly R9,620 cash outflow, reduces wage balances, no duplicate expense", async () => {
    const before = await listFinanceBundle(adminSession);
    const cashBefore = computeCashSummary(before.accounts, before.journalEntries).unrestrictedCashCents;

    const workers12 = Array.from({ length: 12 }, (_, i) => ({
      workerId: `w-road-${i + 1}`,
      amountCents: 76000, // 12 * R760 = R9,120
    }));
    const cook = { workerId: "w-cook", amountCents: 50000 }; // R500

    const approvedRun: PayrollRun = {
      id: "run-wk48",
      businessId: SYNTHETIC_BIZ_A,
      jobId: SYNTHETIC_JOB_1,
      weekStartDate: "2026-11-23",
      weekEndDate: "2026-11-29",
      revision: 1,
      status: "approved",
      grossTotalCents: 1550000,
      adjustmentsTotalCents: 0,
      deductionsTotalCents: 0,
      netTotalCents: 1550000,
      earnings: [
        ...workers12.map((w) => ({
          id: `line-${w.workerId}`,
          workerId: w.workerId,
          workerName: w.workerId,
          roleName: "Road worker",
          roleType: "road_worker" as const,
          daysWorked: 5,
          normalHours: 45,
          weekdayOtHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          publicHolidayHours: 0,
          normalPayCents: 125000,
          weekdayOtPayCents: 0,
          saturdayPayCents: 0,
          sundayPayCents: 0,
          publicHolidayPayCents: 0,
          grossPayCents: 125000,
          adjustmentsCents: 0,
          deductionsCents: 0,
          netPayCents: 125000,
          hasUnknownAttendance: false,
          hasUnconfirmedRate: false,
          ruleSnapshots: [],
          missingRateReasons: [],
        })),
        {
          id: "line-w-cook",
          workerId: "w-cook",
          workerName: "Cook",
          roleName: "Camp cook",
          roleType: "cook" as const,
          daysWorked: 5,
          normalHours: 40,
          weekdayOtHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          publicHolidayHours: 0,
          normalPayCents: 50000,
          weekdayOtPayCents: 0,
          saturdayPayCents: 0,
          sundayPayCents: 0,
          publicHolidayPayCents: 0,
          grossPayCents: 50000,
          adjustmentsCents: 0,
          deductionsCents: 0,
          netPayCents: 50000,
          hasUnknownAttendance: false,
          hasUnconfirmedRate: false,
          ruleSnapshots: [],
          missingRateReasons: [],
        },
      ],
      adjustments: [],
      approvedByEmail: adminSession.email,
      approvedAt: "2026-11-27T08:00:00Z",
      correctionReason: null,
      supersedesRunId: null,
      createdByEmail: adminSession.email,
      createdAt: "2026-11-27T08:00:00Z",
    };

    const payment = await recordBulkWagePayment(ownerSession, {
      jobId: SYNTHETIC_JOB_1,
      paymentDate: "2026-11-27",
      accountId: "acc-cash-a",
      method: "cash",
      reference: "WAGES-WK48",
      evidenceNote: "Signed register",
      workerAmounts: [...workers12, cook],
      approvedRuns: [approvedRun],
    });

    expect(payment.totalAmountCents).toBe(962000); // R 9 620.00
    expect(payment.evidenceStatus).toBe("reported"); // Owner-reported is never auto-verified

    const after = await listFinanceBundle(adminSession);
    const cashAfter = computeCashSummary(after.accounts, after.journalEntries).unrestrictedCashCents;
    expect(cashBefore - cashAfter).toBe(962000);
    expect(after.expenses).toHaveLength(0); // No duplicate expense created
    expect(after.journalEntries.filter((j) => j.sourceType === "wage_payment")).toHaveLength(1);

    const cookSummary = summarizeWorkerWagePayments("w-cook", after.wagePayments);
    expect(cookSummary.allocatedByRunId["run-wk48"]).toBe(50000);
    expect(cookSummary.unallocatedAdvanceCents).toBe(0);

    // Attempting to log wages in expenses must be rejected
    await expect(
      recordExpense(ownerSession, {
        jobId: SYNTHETIC_JOB_1,
        expenseDate: "2026-11-27",
        category: "wages",
        classification: "operating",
        amountCents: 50000,
        paidAmountCents: 50000,
        paymentStatus: "paid",
        accountId: "acc-cash-a",
        method: "cash",
        supplierName: "",
        description: "Duplicate wages",
        reference: "",
        fuelLitres: null,
        vehicleOrMachine: "",
        odometerKm: null,
        receiptAttachment: null,
        missingReceiptReason: "Cash",
      }),
    ).rejects.toThrow(/wage payments/i);
  });

  it("T14: Owner and Admin reporting the same transfer match into exactly one journal posting with both sides' evidence", async () => {
    const first = await recordOrMatchTransfer(adminSession, {
      transferDate: "2026-11-27",
      fromAccountId: null,
      toAccountId: "acc-bank-a",
      amountCents: 1500000,
      sharedReference: "EFT-MATCH-01",
      description: "Working capital transfer",
      transferKind: "lender_advance",
      note: "Admin EFT proof",
    });
    expect(first.matchedExisting).toBe(false);
    expect(first.transfer.status).toBe("pending_match");

    const second = await recordOrMatchTransfer(ownerSession, {
      transferDate: "2026-11-27",
      fromAccountId: null,
      toAccountId: "acc-bank-a",
      amountCents: 1500000,
      sharedReference: "eft-match-01",
      description: "Received in bank",
      transferKind: "lender_advance",
      note: "Owner bank SMS confirmed",
    });
    expect(second.matchedExisting).toBe(true);
    expect(second.transfer.status).toBe("matched");
    expect(second.transfer.reportedByAdmin?.note).toBe("Admin EFT proof");
    expect(second.transfer.confirmedByOwner?.note).toBe("Owner bank SMS confirmed");

    const bundle = await listFinanceBundle(adminSession);
    expect(bundle.transfers).toHaveLength(1);
    expect(bundle.journalEntries.filter((j) => j.sourceType === "transfer")).toHaveLength(1);
  });

  it("T15: Opening loan R256,900 with R135,000 then R100,000 repayments leaves R21,900; R0 interest; no operating expense posting", async () => {
    const initial = await listFinanceBundle(adminSession);
    const loanId = initial.loans[0]!.id;

    await recordLoanEvent(adminSession, {
      loanId,
      eventDate: "2026-12-10",
      eventType: "repayment",
      amountCents: 13500000, // R 135 000.00
      accountId: "acc-bank-a",
      restrictedEligibilityApproved: false,
      reference: "REP-1",
      note: "Second job progress repayment",
    });
    await recordLoanEvent(adminSession, {
      loanId,
      eventDate: "2027-01-20",
      eventType: "repayment",
      amountCents: 10000000, // R 100 000.00
      accountId: "acc-bank-a",
      restrictedEligibilityApproved: false,
      reference: "REP-2",
      note: "Final receipt repayment",
    });

    const after = await listFinanceBundle(adminSession);
    const balance = calculateLoanBalanceCents(after.loans[0]!, after.loanEvents);
    expect(balance.remainingPrincipalCents).toBe(2190000); // R 21 900.00
    expect(after.loans[0]!.interestRatePercent).toBe(0);
    const hasOpexLine = after.journalEntries.some((je) =>
      je.lines.some((ln) => ln.accountType === "operating_expenses"),
    );
    expect(hasOpexLine).toBe(false);
  });

  it("T16: Restricted grant is excluded from unrestricted cash and blocked from loan repayment unless explicitly eligible", async () => {
    const before = await listFinanceBundle(adminSession);
    const unrestrictedBefore = computeCashSummary(before.accounts, before.journalEntries).unrestrictedCashCents;

    await recordRestrictedGrantReceipt(adminSession, {
      receiptDate: "2026-11-27",
      amountCents: 5000000, // R 50 000.00
      reference: "GRANT-PPE-01",
      description: "Safety PPE & equipment grant",
    });

    const after = await listFinanceBundle(adminSession);
    const summary = computeCashSummary(after.accounts, after.journalEntries);
    expect(summary.unrestrictedCashCents).toBe(unrestrictedBefore);
    expect(summary.restrictedCashCents).toBe(5000000);

    // Attempting to repay loan from restricted funding without eligibility approval is blocked
    await expect(
      recordLoanEvent(adminSession, {
        loanId: after.loans[0]!.id,
        eventDate: "2026-11-28",
        eventType: "repayment",
        amountCents: 1000000,
        accountId: "acc-restricted-a",
        restrictedEligibilityApproved: false,
        reference: "BAD-REP",
        note: "Attempted unapproved grant use",
      }),
    ).rejects.toThrow(/restricted funding/i);
  });

  it("T17: Opening R49,900, weekly cash cost R28,500, next receipt after 3 weeks produces R35,600 shortfall before receipt", () => {
    const result = calculateWeeklyCashForecast({
      openingUnrestrictedCashCents: 4990000, // R 49 900.00
      weeklyCashCostCents: 2850000, // R 28 500.00
      weeksCount: 5,
      startWeekDate: "2026-11-23",
      expectedReceipts: [
        { weekIndex: 3, amountCents: 15000000, label: "Progress claim 1" }, // arrives in week 4 (after 3 weeks)
      ],
    });

    // End of week 1: 49,900 - 28,500 = 21,400
    // End of week 2: 21,400 - 28,500 = -7,100 (earliest negative week)
    // End of week 3: -7,100 - 28,500 = -35,600 (shortfall before receipt)
    expect(result.earliestNegativeWeekIndex).toBe(1);
    expect(result.rows[2]!.closingCashCents).toBe(-3560000);
    expect(result.peakShortfallCents).toBe(3560000); // R 35 600.00
  });

  it("T23: Missing receipt requires reason, sets review flag, and still deducts actual cash when paid", async () => {
    const before = await listFinanceBundle(adminSession);
    const cashBefore = computeCashSummary(before.accounts, before.journalEntries).unrestrictedCashCents;

    // Missing both attachment and reason must fail
    await expect(
      recordExpense(ownerSession, {
        jobId: SYNTHETIC_JOB_1,
        expenseDate: "2026-11-27",
        category: "supplies",
        classification: "operating",
        amountCents: 45000,
        paidAmountCents: 45000,
        paymentStatus: "paid",
        accountId: "acc-cash-a",
        method: "cash",
        supplierName: "Roadside hardware",
        description: "Nylon trimmer line",
        reference: "",
        fuelLitres: null,
        vehicleOrMachine: "",
        odometerKm: null,
        receiptAttachment: null,
        missingReceiptReason: "",
      }),
    ).rejects.toThrow(/missing-receipt reason/i);

    const exp = await recordExpense(ownerSession, {
      jobId: SYNTHETIC_JOB_1,
      expenseDate: "2026-11-27",
      category: "supplies",
      classification: "operating",
      amountCents: 45000,
      paidAmountCents: 45000,
      paymentStatus: "paid",
      accountId: "acc-cash-a",
      method: "cash",
      supplierName: "Roadside hardware",
      description: "Nylon trimmer line",
      reference: "",
      fuelLitres: null,
      vehicleOrMachine: "",
      odometerKm: null,
      receiptAttachment: null,
      missingReceiptReason: "Cash seller had no receipt book",
    });

    expect(exp.needsReview).toBe(true);
    expect(exp.missingReceiptReason).toBe("Cash seller had no receipt book");

    const after = await listFinanceBundle(adminSession);
    const cashAfter = computeCashSummary(after.accounts, after.journalEntries).unrestrictedCashCents;
    expect(cashBefore - cashAfter).toBe(45000);
  });

  it("T21: Supervisor cannot view cash accounts, ledger, wage payments, or loans", async () => {
    const supBundle = await listFinanceBundle(supervisorSession);
    expect(supBundle.accounts).toHaveLength(0);
    expect(supBundle.journalEntries).toHaveLength(0);
    expect(supBundle.wagePayments).toHaveLength(0);
    expect(supBundle.loans).toHaveLength(0);

    await expect(
      recordBulkWagePayment(supervisorSession, {
        jobId: SYNTHETIC_JOB_1,
        paymentDate: "2026-11-27",
        accountId: "acc-cash-a",
        method: "cash",
        reference: "",
        evidenceNote: "",
        workerAmounts: [{ workerId: "w1", amountCents: 10000 }],
        approvedRuns: [],
      }),
    ).rejects.toThrow(/access denied/i);
  });
});