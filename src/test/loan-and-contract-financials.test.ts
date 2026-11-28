import { beforeEach, describe, expect, it } from "vitest";
import type { AuthSession, Job } from "@/lib/domain/types";
import type { FinanceBundle } from "@/lib/domain/increment-d-types";
import {
  addLoanRepaymentSchedule,
  createCustomerInvoice,
  createLoanAccount,
  listFinanceBundle,
  recordCustomerMilestoneReceipt,
  recordLoanEvent,
} from "@/lib/data/increment-d-repository";
import {
  buildLoanStatement,
  calculateLoanBalanceCents,
  calculateWeeklyCashForecast,
  computeAccountBalanceCents,
  computeCashSummary,
  evaluateLoanRepaymentSchedule,
  summarizeContractReceivables,
} from "@/lib/domain/finance-calc";
import { buildSafeCsv, buildSpreadsheetXml } from "@/lib/domain/increment-e-calc";

const CLEAN_BIZ = "00000000-0000-0000-0000-000000000099";
const NEW_JOB_ID = "00000000-0000-0000-0000-000000000199";

const adminSession: AuthSession = {
  userId: "user-admin-clean",
  email: "admin@clean.invalid",
  fullName: "Admin User",
  role: "admin",
  businessId: CLEAN_BIZ,
  businessName: "Vuyo Contracting (Isolated Test)",
  assignedJobIds: [],
  mode: "synthetic_dev",
};

const ownerSession: AuthSession = {
  ...adminSession,
  userId: "user-owner-clean",
  email: "owner@clean.invalid",
  fullName: "Owner User",
  role: "owner",
};

const supervisorSession: AuthSession = {
  ...adminSession,
  userId: "user-sup-clean",
  email: "sup@clean.invalid",
  fullName: "Supervisor User",
  role: "supervisor",
  assignedJobIds: [NEW_JOB_ID],
};

function seedZeroBalanceCleanBusiness(): void {
  const cleanStore: FinanceBundle = {
    accounts: [
      { id: "acc-bank", businessId: CLEAN_BIZ, code: "1010", name: "Business Bank Account", accountType: "bank", isCashAccount: true, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-cash", businessId: CLEAN_BIZ, code: "1020", name: "Cash on Hand", accountType: "cash", isCashAccount: true, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-restr", businessId: CLEAN_BIZ, code: "1030", name: "Restricted Funding", accountType: "restricted_funding", isCashAccount: true, isRestricted: true, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-wages", businessId: CLEAN_BIZ, code: "2100", name: "Wages Payable", accountType: "wages_payable", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-loan", businessId: CLEAN_BIZ, code: "2200", name: "Zero-Interest Loan Liability", accountType: "loan_liability", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-rev", businessId: CLEAN_BIZ, code: "4000", name: "Customer Contract Receipts", accountType: "customer_revenue", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-opex", businessId: CLEAN_BIZ, code: "5100", name: "Operating Expenses", accountType: "operating_expenses", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
      { id: "acc-capex", businessId: CLEAN_BIZ, code: "1500", name: "Capital Expenditure", accountType: "capital_expenditure", isCashAccount: false, isRestricted: false, openingBalanceCents: 0, openingBalanceVerified: true, active: true },
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
    customerReceipts: [],
    expenseSettlements: [],
    forecastAssumptions: [],
  };
  window.localStorage.setItem("worktrack_synthetic_increment_d_v1", JSON.stringify(cleanStore));
}

const newContractJob: Job = {
  id: NEW_JOB_ID,
  businessId: CLEAN_BIZ,
  name: "New Verge Contract 2026",
  customerName: "Provincial Roads",
  roadOrArea: "R401 Section B",
  contractReference: "CTR-2026-NEW",
  contractValueCents: 44000000, // R 440 000.00
  vatBasis: "not_registered",
  status: "active",
  plannedStartDate: "2026-12-01",
  plannedEndDate: "2027-02-28",
  actualStartDate: "2026-12-01",
  actualEndDate: null,
  workRequirements: "Verge clearing",
  openingCashAllocationCents: 0,
  revision: 1,
  createdAt: "2026-12-01T00:00:00Z",
  updatedAt: "2026-12-01T00:00:00Z",
};

describe("Manual opening loan liability, partial customer receipts, advances, repayments & final settlement", () => {
  beforeEach(() => {
    seedZeroBalanceCleanBusiness();
  });

  it("starts at zero after business reset, establishes manual opening loan with R0 cash/profit impact, handles part payments, advances, scheduled repayments, and final settlement", async () => {
    // 1. Clean post-reset zero opening state
    const initial = await listFinanceBundle(adminSession);
    expect(initial.loans).toHaveLength(0);
    expect(initial.loanEvents).toHaveLength(0);
    expect(computeCashSummary(initial.accounts, initial.journalEntries).unrestrictedCashCents).toBe(0);

    // 2. Manually create opening loan liability (R256,900.00) from previous contract
    const loan = await createLoanAccount(adminSession, {
      lenderName: "Mark Pattison",
      openingPrincipalCents: 25690000,
      effectiveDate: "2026-12-01",
      reference: "PRIOR-CONTRACT-LOAN",
      notes: "Opening liability carried over from previous contract",
      repaymentTermsNote: "0% interest; repay as contract progress receipts clear",
      openingPrincipalVerified: true,
    });
    expect(loan.interestRatePercent).toBe(0);
    expect(loan.openingPrincipalCents).toBe(25690000);

    // Cash balance and operating expenses MUST remain R0
    const afterOpening = await listFinanceBundle(adminSession);
    expect(computeCashSummary(afterOpening.accounts, afterOpening.journalEntries).unrestrictedCashCents).toBe(0);
    const opexAccount = afterOpening.accounts.find((a) => a.accountType === "operating_expenses")!;
    expect(computeAccountBalanceCents(opexAccount, afterOpening.journalEntries)).toBe(0);
    expect(calculateLoanBalanceCents(loan, afterOpening.loanEvents).remainingPrincipalCents).toBe(25690000);

    // 3. Record customer contract milestones totaling R440,000.00
    const ms1 = await createCustomerInvoice(adminSession, {
      jobId: NEW_JOB_ID,
      label: "Progress Claim 1",
      reference: "INV-001",
      expectedDate: "2026-12-15",
      amountCents: 24000000, // R 240 000.00
    });
    const ms2 = await createCustomerInvoice(adminSession, {
      jobId: NEW_JOB_ID,
      label: "Final Claim 2",
      reference: "INV-002",
      expectedDate: "2027-01-15",
      amountCents: 20000000, // R 200 000.00
    });

    // 4. Multiple partial customer payments against the same contract
    await recordCustomerMilestoneReceipt(adminSession, {
      milestoneId: ms1.id,
      receivedDate: "2026-12-15",
      receivedAmountCents: 10000000, // R 100 000.00 part payment 1
      accountId: "acc-bank",
      reference: "EFT-CUST-01",
    });
    // Duplicate customer receipt with same reference/date/amount must be rejected
    await expect(
      recordCustomerMilestoneReceipt(adminSession, {
        milestoneId: ms1.id,
        receivedDate: "2026-12-15",
        receivedAmountCents: 10000000,
        accountId: "acc-bank",
        reference: "EFT-CUST-01",
      }),
    ).rejects.toThrow(/duplicate customer receipt/i);

    await recordCustomerMilestoneReceipt(adminSession, {
      milestoneId: ms1.id,
      receivedDate: "2026-12-20",
      receivedAmountCents: 14000000, // R 140 000.00 part payment 2 (completes ms1)
      accountId: "acc-bank",
      reference: "EFT-CUST-02",
    });

    const afterPartPayments = await listFinanceBundle(adminSession);
    const receivablesMid = summarizeContractReceivables([newContractJob], afterPartPayments.milestones);
    expect(receivablesMid.totalContractValueCents).toBe(44000000);
    expect(receivablesMid.totalCustomerReceivedCents).toBe(24000000);
    expect(receivablesMid.remainingContractReceivablesCents).toBe(20000000);
    expect(computeCashSummary(afterPartPayments.accounts, afterPartPayments.journalEntries).unrestrictedCashCents).toBe(24000000);

    // 5. Additional loan advance during contract (R15,000.00): increases BOTH cash and loan liability
    await recordLoanEvent(adminSession, {
      loanId: loan.id,
      eventDate: "2026-12-22",
      eventType: "advance",
      amountCents: 1500000,
      accountId: "acc-bank",
      restrictedEligibilityApproved: false,
      reference: "ADV-001",
      note: "Additional working-capital advance",
    });
    const afterAdvance = await listFinanceBundle(adminSession);
    expect(computeCashSummary(afterAdvance.accounts, afterAdvance.journalEntries).unrestrictedCashCents).toBe(25500000);
    expect(calculateLoanBalanceCents(loan, afterAdvance.loanEvents).remainingPrincipalCents).toBe(27190000);

    // 6. Optional agreed repayment schedule + overdue detection + cash flow forecast integration
    await addLoanRepaymentSchedule(adminSession, {
      loanId: loan.id,
      expectedDate: "2026-12-21", // overdue as of 2026-12-23
      expectedAmountCents: 13500000,
      reference: "SCHED-1",
      note: "First agreed repayment",
    });
    await addLoanRepaymentSchedule(adminSession, {
      loanId: loan.id,
      expectedDate: "2027-01-20",
      expectedAmountCents: 13690000,
      reference: "SCHED-2",
      note: "Final agreed settlement",
    });

    const withSchedule = await listFinanceBundle(adminSession);
    const evalBeforeRepay = evaluateLoanRepaymentSchedule(
      loan,
      withSchedule.loanEvents,
      withSchedule.loanRepaymentSchedules ?? [],
      "2026-12-23",
    );
    expect(evalBeforeRepay.overdueCount).toBe(1);
    expect(evalBeforeRepay.totalOverdueCents).toBe(13500000);

    const forecast = calculateWeeklyCashForecast({
      openingUnrestrictedCashCents: 25500000,
      weeklyCashCostCents: 0,
      weeksCount: 8,
      startWeekDate: "2026-12-21",
      expectedReceipts: [{ weekIndex: 4, amountCents: 20000000, label: "Final Claim 2" }],
      scheduledLoanRepayments: [
        { weekIndex: 0, amountCents: 13500000, label: "Mark Pattison (SCHED-1)" },
        { weekIndex: 4, amountCents: 13690000, label: "Mark Pattison (SCHED-2)" },
      ],
    });
    expect(forecast.rows[0]!.closingCashCents).toBe(12000000);
    expect(forecast.rows[0]!.notes.some((n) => n.includes("Loan repayment"))).toBe(true);

    // 7. Partial loan repayment (R135,000.00): reduces BOTH cash and loan balance, R0 operating expense
    await recordLoanEvent(adminSession, {
      loanId: loan.id,
      eventDate: "2026-12-24",
      eventType: "repayment",
      amountCents: 13500000,
      accountId: "acc-bank",
      restrictedEligibilityApproved: false,
      reference: "REPAY-001",
      note: "Partial repayment from claim 1",
    });
    // Duplicate repayment rejected
    await expect(
      recordLoanEvent(adminSession, {
        loanId: loan.id,
        eventDate: "2026-12-24",
        eventType: "repayment",
        amountCents: 13500000,
        accountId: "acc-bank",
        restrictedEligibilityApproved: false,
        reference: "REPAY-001",
        note: "Duplicate attempt",
      }),
    ).rejects.toThrow(/duplicate loan transaction/i);

    // Receive final customer payment (R200,000.00)
    await recordCustomerMilestoneReceipt(adminSession, {
      milestoneId: ms2.id,
      receivedDate: "2027-01-15",
      receivedAmountCents: 20000000,
      accountId: "acc-bank",
      reference: "EFT-CUST-03",
    });

    // Overpayment beyond remaining principal (R136,900.00) must be blocked
    await expect(
      recordLoanEvent(adminSession, {
        loanId: loan.id,
        eventDate: "2027-01-18",
        eventType: "repayment",
        amountCents: 14000000,
        accountId: "acc-bank",
        restrictedEligibilityApproved: false,
        reference: "REPAY-OVER",
        note: "Exceeds remaining balance",
      }),
    ).rejects.toThrow(/exceeds remaining loan principal/i);

    // 8. Final loan settlement (R136,900.00 -> remaining principal = R0.00)
    await recordLoanEvent(adminSession, {
      loanId: loan.id,
      eventDate: "2027-01-18",
      eventType: "repayment",
      amountCents: 13690000,
      accountId: "acc-bank",
      restrictedEligibilityApproved: false,
      reference: "REPAY-FINAL",
      note: "Final loan settlement",
    });

    const finalBundle = await listFinanceBundle(adminSession);
    const finalCash = computeCashSummary(finalBundle.accounts, finalBundle.journalEntries).unrestrictedCashCents;
    const finalRev = computeAccountBalanceCents(
      finalBundle.accounts.find((a) => a.accountType === "customer_revenue")!,
      finalBundle.journalEntries,
    );
    const finalOpex = computeAccountBalanceCents(
      finalBundle.accounts.find((a) => a.accountType === "operating_expenses")!,
      finalBundle.journalEntries,
    );
    const finalReceivables = summarizeContractReceivables([newContractJob], finalBundle.milestones);
    const statement = buildLoanStatement(loan, finalBundle.loanEvents);

    // Verify clear distinction between cash, contract profitability, receivables, and loan liability
    // Cash = R440,000 receipts + R15,000 advance - R271,900 repayments = R183,100.00
    expect(finalCash).toBe(18310000);
    // Contract revenue = R440,000.00; operating expenses = R0 (loan repayments never hit opex)
    expect(finalRev).toBe(44000000);
    expect(finalOpex).toBe(0);
    // Receivables = R0.00
    expect(finalReceivables.remainingContractReceivablesCents).toBe(0);
    // Loan statement closing balance = R0.00 with exact running balances
    expect(statement.closingBalanceCents).toBe(0);
    expect(statement.rows.map((r) => r.runningBalanceCents)).toEqual([
      25690000, // Opening
      27190000, // +R15,000 advance
      13690000, // -R135,000 repayment
      0,        // -R136,900 final settlement
    ]);

    // Exportable CSV & Excel loan statement
    const meta = {
      title: "Loan Statement",
      businessName: adminSession.businessName,
      dateRange: "2026-12-01 to 2027-01-18",
      revision: loan.reference ?? "LOAN",
      status: "Settled",
      sourceIds: statement.rows.map((r) => r.id),
      generatedAt: "2027-01-18T10:00:00Z",
    };
    const csv = buildSafeCsv(meta, ["Date", "Balance"], statement.rows.map((r) => [r.date, r.runningBalanceCents]));
    const xls = buildSpreadsheetXml(meta, ["Date", "Balance"], statement.rows.map((r) => [r.date, r.runningBalanceCents]));
    expect(csv).toContain("Loan Statement");
    expect(xls).toContain("Workbook");

    // Role boundaries: Owner can read, cannot edit; Supervisor denied
    const ownerView = await listFinanceBundle(ownerSession);
    expect(ownerView.loans).toHaveLength(1);
    expect(ownerView.loanEvents).toHaveLength(3);
    await expect(
      createLoanAccount(ownerSession, {
        lenderName: "Unauthorised",
        openingPrincipalCents: 1000,
        effectiveDate: "2026-12-01",
        reference: "X",
      }),
    ).rejects.toThrow(/access denied/i);

    const supView = await listFinanceBundle(supervisorSession);
    expect(supView.loans).toHaveLength(0);
    expect(supView.loanEvents).toHaveLength(0);
    expect(supView.loanRepaymentSchedules).toHaveLength(0);
  });
});