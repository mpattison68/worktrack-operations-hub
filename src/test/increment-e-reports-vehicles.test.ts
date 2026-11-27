import { beforeEach, describe, expect, it } from "vitest";
import type { AuthSession, Job } from "@/lib/domain/types";
import type { PayrollRun } from "@/lib/domain/increment-c-types";
import {
  assembleWeeklyReportSnapshot,
  buildSafeCsv,
  calculateAssetFuelConsumption,
  escapeCsvCell,
  evaluateBusinessAlerts,
  evaluatePreUseCheck,
} from "@/lib/domain/increment-e-calc";
import {
  approveWeeklyReport,
  listIncrementEBundle,
  recordPreUseCheck,
  resetSyntheticIncrementEStore,
  resolveAssetDefect,
  returnWeeklyReport,
  startWeeklyReportAmendment,
  submitWeeklyReport,
} from "@/lib/data/increment-e-repository";
import { can } from "@/lib/permissions";
import { SYNTHETIC_BIZ_A, SYNTHETIC_JOB_1 } from "@/lib/data/synthetic-fixtures";

const adminSession: AuthSession = {
  userId: "u-admin-a",
  email: "admin@synthetic.worktrack.local",
  fullName: "Naledi Dlamini (Synthetic Admin)",
  businessId: SYNTHETIC_BIZ_A,
  businessName: "Karoo Verge Clearing (Synthetic Dev)",
  role: "admin",
  assignedJobIds: [],
  mode: "synthetic_dev",
};

const ownerSession: AuthSession = {
  ...adminSession,
  userId: "u-owner-a",
  email: "owner@synthetic.worktrack.local",
  fullName: "Sipho Mokoena (Synthetic Owner)",
  role: "owner",
};

const supervisorSession: AuthSession = {
  ...adminSession,
  userId: "u-sup-a",
  email: "supervisor@synthetic.worktrack.local",
  fullName: "Thabo Ndlovu (Synthetic Supervisor)",
  role: "supervisor",
  assignedJobIds: [SYNTHETIC_JOB_1],
};

const sampleJob: Job = {
  id: SYNTHETIC_JOB_1,
  businessId: SYNTHETIC_BIZ_A,
  name: "R401 Northern Verge Clearing",
  customerName: "Synthetic Roads Dept",
  contractReference: "SYN-R401",
  contractValueCents: 45000000,
  vatBasis: "not_registered",
  roadOrArea: "R401 km 0–15",
  status: "active",
  plannedStartDate: "2026-11-02",
  plannedEndDate: "2026-12-18",
  actualStartDate: "2026-11-02",
  actualEndDate: null,
  openingCashAllocationCents: 0,
  workRequirements: "Brush cutting and clearing",
  revision: 1,
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
};

describe("Increment E — Weekly Reports, Vehicles, Exports & Notifications", () => {
  beforeEach(() => {
    resetSyntheticIncrementEStore();
  });

  it("T18: submitted weekly report returned, amended, and approved retains history with locked snapshot and no duplicated payroll", async () => {
    const payrollRuns: PayrollRun[] = [
      {
        id: "pr-superseded",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        weekStartDate: "2026-11-23",
        weekEndDate: "2026-11-29",
        revision: 1,
        status: "superseded",
        grossTotalCents: 1200000,
        adjustmentsTotalCents: 0,
        deductionsTotalCents: 0,
        netTotalCents: 1200000,
        earnings: [],
        adjustments: [],
        approvedByEmail: null,
        approvedAt: null,
        correctionReason: null,
        supersedesRunId: null,
        createdByEmail: adminSession.email,
        createdAt: "2026-11-27T08:00:00.000Z",
      },
      {
        id: "pr-approved-2",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        weekStartDate: "2026-11-23",
        weekEndDate: "2026-11-29",
        revision: 2,
        status: "approved",
        grossTotalCents: 1500000,
        adjustmentsTotalCents: 0,
        deductionsTotalCents: 0,
        netTotalCents: 1500000,
        earnings: [],
        adjustments: [],
        approvedByEmail: adminSession.email,
        approvedAt: "2026-11-27T09:00:00.000Z",
        correctionReason: "Updated attendance",
        supersedesRunId: "pr-superseded",
        createdByEmail: adminSession.email,
        createdAt: "2026-11-27T09:00:00.000Z",
      },
    ];

    const snap = assembleWeeklyReportSnapshot({
      job: sampleJob,
      weekStart: "2026-11-23",
      weekEnd: "2026-11-29",
      progressEntries: [],
      cumulativeCompletedPercent: 42.5,
      effortWeightedPercent: 48.0,
      interruptions: [],
      teamDays: [],
      attendanceEntries: [],
      payrollRuns,
      wagePayments: [],
      workers: [],
      expenses: [],
      financeBundle: {
        accounts: [],
        journalEntries: [],
        wagePayments: [],
        expenses: [],
        expenseRequests: [],
        transfers: [],
        reconciliations: [],
        milestones: [],
        loans: [],
        loanEvents: [],
      },
      checks: [],
      defects: [],
    });

    // Must pick single authoritative approved payroll run (R 15 000.00), never sum superseded + approved
    expect(snap.wagesEarnedCents).toBe(1500000);
    expect(snap.payrollRunId).toBe("pr-approved-2");

    // 1. Owner submits Rev 1 (acknowledging missing truck check)
    const submitted1 = await submitWeeklyReport(ownerSession, {
      snapshot: snap,
      missingEvidenceAcknowledged: true,
      comment: "Initial submission",
    });
    expect(submitted1.status).toBe("submitted");
    expect(submitted1.currentRevision).toBe(1);

    // 2. Admin returns with comment
    const returned = await returnWeeklyReport(
      adminSession,
      submitted1.id,
      "Attach Friday truck check note",
    );
    expect(returned.status).toBe("returned");
    expect(returned.latestComment).toContain("Friday truck check");

    // 3. Owner amends & resubmits -> Rev 2
    const submitted2 = await submitWeeklyReport(ownerSession, {
      snapshot: { ...snap, truckChecksCount: 1 },
      missingEvidenceAcknowledged: true,
      comment: "Added Friday check",
    });
    expect(submitted2.currentRevision).toBe(2);
    expect(submitted2.status).toBe("submitted");

    // 4. Admin approves -> locked snapshot, full revision history preserved
    const approved = await approveWeeklyReport(adminSession, submitted2.id, "Verified");
    expect(approved.status).toBe("approved");
    expect(approved.lockedSnapshot?.wagesEarnedCents).toBe(1500000);
    expect(approved.revisions.map((r) => r.status)).toEqual([
      "submitted",
      "returned",
      "submitted",
      "approved",
    ]);

    // 5. Direct resubmit on approved report is blocked until amendment opened
    await expect(
      submitWeeklyReport(ownerSession, {
        snapshot: snap,
        missingEvidenceAcknowledged: true,
      }),
    ).rejects.toThrow(/locked/i);

    const amended = await startWeeklyReportAmendment(adminSession, approved.id, "Late invoice");
    expect(amended.status).toBe("draft");
  });

  it("T22: critical truck oil problem triggers immediate STOP DO NOT USE, marks asset unavailable, queues alert, and requires authorized resolution", async () => {
    const evalResult = evaluatePreUseCheck({
      oil: "problem",
      coolant: "ok",
      leaks: "ok",
      tyres: "ok",
      brakes_lights: "ok",
      warning_lights: "ok",
    });
    expect(evalResult.stopUseTriggered).toBe(true);
    expect(evalResult.failedCriticalItems).toEqual(["oil"]);

    // Unchecked critical item also triggers STOP DO NOT USE
    const uncheckedEval = evaluatePreUseCheck({
      oil: "ok",
      coolant: "ok",
      leaks: "ok",
      tyres: "ok",
      brakes_lights: "not_checked",
      warning_lights: "ok",
    });
    expect(uncheckedEval.stopUseTriggered).toBe(true);
    expect(uncheckedEval.failedCriticalItems).toEqual(["brakes_lights"]);

    const res = await recordPreUseCheck(ownerSession, {
      assetId: "asset-truck-1",
      jobId: SYNTHETIC_JOB_1,
      checkDate: "2026-11-27",
      odometerKm: 148300,
      items: {
        oil: "problem",
        coolant: "ok",
        leaks: "ok",
        tyres: "ok",
        brakes_lights: "ok",
        warning_lights: "ok",
      },
      comment: "Oil below minimum mark",
      photoNote: "dipstick.jpg",
      isOffline: true,
    });

    expect(res.check.stopUseTriggered).toBe(true);
    expect(res.check.syncStatus).toBe("queued_offline");
    expect(res.defect?.status).toBe("open");
    expect(res.notification?.type).toBe("vehicle_stop_use");

    const bundleAfterDefect = await listIncrementEBundle(adminSession);
    const truck = bundleAfterDefect.assets.find((a) => a.id === "asset-truck-1");
    expect(truck?.status).toBe("unavailable_defect");

    // Supervisor cannot clear a STOP DO NOT USE defect
    await expect(
      resolveAssetDefect(supervisorSession, res.defect!.id, "Tried to clear"),
    ).rejects.toThrow(/access denied/i);

    // Admin resolves defect -> asset returns to available
    const resolved = await resolveAssetDefect(
      adminSession,
      res.defect!.id,
      "Workshop topped up oil and replaced sump gasket",
    );
    expect(resolved.status).toBe("resolved");

    const bundleAfterResolve = await listIncrementEBundle(adminSession);
    const truckAfter = bundleAfterResolve.assets.find((a) => a.id === "asset-truck-1");
    expect(truckAfter?.status).toBe("available");
  });

  it("T21 & security: Supervisor cannot view VINs, cannot export financials, and CSV escapes formula injection", async () => {
    expect(can("supervisor", "exports.financial")).toBe(false);
    expect(can("supervisor", "exports.operational")).toBe(true);
    expect(can("supervisor", "reports.submit")).toBe(false);
    expect(can("supervisor", "vehicles.view_vin")).toBe(false);

    const supBundle = await listIncrementEBundle(supervisorSession);
    const truckForSup = supBundle.assets.find((a) => a.id === "asset-truck-1");
    expect(truckForSup?.vin).toBeNull();
    expect(truckForSup?.purchaseCostCents).toBeNull();

    // CSV formula injection escaping
    expect(escapeCsvCell("=CMD|' /C calc'!A0")).toBe("'=CMD|' /C calc'!A0");
    expect(escapeCsvCell("+1+2")).toBe("'+1+2");
    expect(escapeCsvCell("-100")).toBe("'-100");
    expect(escapeCsvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(escapeCsvCell("Normal text")).toBe("Normal text");

    const csv = buildSafeCsv(
      {
        title: "Test Export",
        businessName: "Karoo Verge",
        dateRange: "23 Nov 2026 to 29 Nov 2026",
        revision: "Rev 1",
        status: "APPROVED",
        sourceIds: ["rep-1"],
        generatedAt: "2026-11-27T12:00:00Z",
      },
      ["Note"],
      [["=HYPERLINK(\"http://evil\")"]],
    );
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csv).toContain("rep-1");
  });

  it("calculates fill-to-fill fuel consumption and deduplicates business alerts", () => {
    const fuel = calculateAssetFuelConsumption([
      {
        id: "f1",
        businessId: SYNTHETIC_BIZ_A,
        assetId: "asset-truck-1",
        entryDate: "2026-11-10",
        entryType: "fuel",
        odometerKm: 100000,
        litres: 80,
        costCents: 180000,
        description: "Fill 1",
        createdBy: "owner",
        createdAt: "2026-11-10T10:00:00Z",
      },
      {
        id: "f2",
        businessId: SYNTHETIC_BIZ_A,
        assetId: "asset-truck-1",
        entryDate: "2026-11-20",
        entryType: "fuel",
        odometerKm: 100500,
        litres: 90,
        costCents: 202500,
        description: "Fill 2",
        createdBy: "owner",
        createdAt: "2026-11-20T10:00:00Z",
      },
    ]);
    expect(fuel.isActualFillToFill).toBe(true);
    expect(fuel.litresPer100Km).toBe(18); // 90L / 500km * 100

    const prefs = {
      businessId: SYNTHETIC_BIZ_A,
      weeklyReportReminderDay: "sunday" as const,
      weeklyReportReminderTimeSAST: "17:00",
      largeExpenseThresholdCents: 500000,
      cashShortfallAlertEnabled: true,
      missingReceiptAlertEnabled: true,
      smtpDigestEnabled: false,
      smtpConfigured: false,
      updatedAt: "2026-11-27T08:00:00Z",
    };

    const firstPass = evaluateBusinessAlerts({
      businessId: SYNTHETIC_BIZ_A,
      preferences: prefs,
      defects: [],
      reports: [],
      expenses: [],
      forecast: {
        rows: [],
        earliestNegativeWeekIndex: 2,
        earliestNegativeWeekDate: "2026-12-07",
        peakShortfallCents: 3560000,
        minimumClosingCashCents: -3560000,
      },
      loanBalanceCents: 25690000,
      existingNotifications: [],
    });
    expect(firstPass.length).toBe(2);

    // Re-evaluating with existing notifications must deduplicate (still 2)
    const secondPass = evaluateBusinessAlerts({
      businessId: SYNTHETIC_BIZ_A,
      preferences: prefs,
      defects: [],
      reports: [],
      expenses: [],
      forecast: {
        rows: [],
        earliestNegativeWeekIndex: 2,
        earliestNegativeWeekDate: "2026-12-07",
        peakShortfallCents: 3560000,
        minimumClosingCashCents: -3560000,
      },
      loanBalanceCents: 25690000,
      existingNotifications: firstPass,
    });
    expect(secondPass.length).toBe(2);
  });
});