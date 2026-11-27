import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { RoadSectionInput } from "@/lib/domain/assessment-types";
import type {
  AttendanceEntry,
  PayrollRun,
  ProgressEntry,
  TeamDay,
} from "@/lib/domain/increment-c-types";
import type {
  AuthSession,
  PayRule,
  Worker,
  WorkerAssignment,
  WorkerRole,
} from "@/lib/domain/types";
import {
  calculateJobProgress,
  detectProgressScopeConflict,
  mergeIntervals,
} from "@/lib/domain/progress-calc";
import {
  buildWorkerStatement,
  calculatePayrollWeek,
  getWeekDates,
  validateAttendanceWeek,
} from "@/lib/domain/payroll-calc";
import { listPayrollRuns, savePayrollRunDraftOrApprove } from "@/lib/data/increment-c-repository";
import { SYNTHETIC_BIZ_A, SYNTHETIC_JOB_1 } from "@/lib/data/synthetic-fixtures";

const BASE_SECTION: RoadSectionInput = {
  id: "sec-1",
  label: "Section 1 (0–1000m)",
  startChainageMeters: 0,
  endChainageMeters: 1000,
  carriageway: "single",
  strips: [{ id: "st-l", side: "left", widthMeters: 5, lengthOverrideMeters: null }],
  difficulty: "harder", // 1.30x
  difficultyReasons: ["thick_grass"],
  activities: ["cutting", "waste_collection"],
  notes: "",
};

function makeProgress(partial: Partial<ProgressEntry>): ProgressEntry {
  return {
    id: partial.id ?? "p-1",
    businessId: SYNTHETIC_BIZ_A,
    jobId: SYNTHETIC_JOB_1,
    sectionId: "sec-1",
    vergeSide: "left",
    activity: "cutting",
    reportedDate: "2026-11-23",
    startChainageMeters: 0,
    endChainageMeters: 500,
    stageStatus: "complete",
    isRework: false,
    source: "manual",
    gpsAccuracyMeters: null,
    photoDate: null,
    evidenceNote: "",
    verificationState: "reported",
    conflictReason: null,
    submittedByEmail: "owner@synthetic.worktrack.local",
    revision: 1,
    createdAt: "2026-11-23T08:00:00Z",
    updatedAt: "2026-11-23T08:00:00Z",
    ...partial,
  };
}

const WEEK_START = "2026-11-23"; // Monday
const WEEK_DATES = getWeekDates(WEEK_START);

const ROLES: WorkerRole[] = [
  {
    id: "role-road",
    businessId: SYNTHETIC_BIZ_A,
    roleType: "road_worker",
    name: "Road worker",
    sharesCrewSchedule: true,
    active: true,
    createdAt: "2026-11-01T00:00:00Z",
  },
  {
    id: "role-cook",
    businessId: SYNTHETIC_BIZ_A,
    roleType: "cook",
    name: "Camp cook",
    sharesCrewSchedule: false,
    active: true,
    createdAt: "2026-11-01T00:00:00Z",
  },
];

function makeCrewFixture(): {
  workers: Worker[];
  assignments: WorkerAssignment[];
  payRules: PayRule[];
  teamDays: TeamDay[];
  cookAttendance: AttendanceEntry[];
} {
  const workers: Worker[] = Array.from({ length: 12 }, (_, idx) => ({
    id: `rw-${idx + 1}`,
    businessId: SYNTHETIC_BIZ_A,
    fullName: `Road Worker ${idx + 1}`,
    contactPhone: null,
    workerRoleId: "role-road",
    employmentStartDate: "2026-11-01",
    employmentEndDate: null,
    active: true,
    openingBalanceCents: 0,
    openingBalanceSource: "Test",
    openingBalanceVerified: true,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  }));
  workers.push({
    id: "cook-1",
    businessId: SYNTHETIC_BIZ_A,
    fullName: "Camp Cook",
    contactPhone: null,
    workerRoleId: "role-cook",
    employmentStartDate: "2026-11-01",
    employmentEndDate: null,
    active: true,
    openingBalanceCents: 0,
    openingBalanceSource: "Test",
    openingBalanceVerified: true,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  });

  const assignments: WorkerAssignment[] = workers.map((w, i) => ({
    id: `as-${i}`,
    businessId: SYNTHETIC_BIZ_A,
    workerId: w.id,
    jobId: SYNTHETIC_JOB_1,
    assignedFrom: "2026-11-01",
    assignedTo: null,
    active: true,
  }));

  const payRules: PayRule[] = [
    {
      id: "pr-road",
      businessId: SYNTHETIC_BIZ_A,
      workerRoleId: "role-road",
      payBasis: "daily",
      baseRateCents: 25000, // R250/day
      normalHoursPerDay: 9,
      normalWorkdaysPerWeek: 5,
      weekdayOtHourlyCents: 4500, // R45/hr approved test rate
      saturdayRateCents: 5000, // R50/hr approved test rate
      sundayRateCents: 6000, // R60/hr approved test rate
      publicHolidayRateCents: 6000,
      weeklyProrationPolicy: "none",
      effectiveFrom: "2026-11-01",
      effectiveTo: null,
      isConfirmed: true,
      notes: "Test confirmed rule",
      createdAt: "2026-11-01T00:00:00Z",
    },
    {
      id: "pr-cook",
      businessId: SYNTHETIC_BIZ_A,
      workerRoleId: "role-cook",
      payBasis: "weekly",
      baseRateCents: 50000, // R500/week
      normalHoursPerDay: 8,
      normalWorkdaysPerWeek: 5,
      weekdayOtHourlyCents: null,
      saturdayRateCents: null,
      sundayRateCents: null,
      publicHolidayRateCents: null,
      weeklyProrationPolicy: "full_week_entitlement",
      effectiveFrom: "2026-11-01",
      effectiveTo: null,
      isConfirmed: true,
      notes: "Test confirmed cook rule",
      createdAt: "2026-11-01T00:00:00Z",
    },
  ];

  const teamDays: TeamDay[] = WEEK_DATES.map((workDate, idx) => ({
    id: `td-${idx}`,
    businessId: SYNTHETIC_BIZ_A,
    jobId: SYNTHETIC_JOB_1,
    workDate,
    dayStatus: idx < 5 ? "worked" : "no_work",
    normalHours: idx < 5 ? 9 : 0,
    weekdayOtHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    publicHolidayHours: 0,
    interruptionReason: null,
    notes: "",
    updatedByEmail: "owner@synthetic.worktrack.local",
    updatedAt: "2026-11-23T08:00:00Z",
  }));

  const cookAttendance: AttendanceEntry[] = WEEK_DATES.map((workDate, idx) => ({
    id: `cook-att-${idx}`,
    businessId: SYNTHETIC_BIZ_A,
    jobId: SYNTHETIC_JOB_1,
    workerId: "cook-1",
    workDate,
    dayStatus: idx < 5 ? "worked" : "no_work",
    normalHours: idx < 5 ? 8 : 0,
    weekdayOtHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    publicHolidayHours: 0,
    isOverride: true,
    overrideReason: "Cook schedule",
    updatedByEmail: "owner@synthetic.worktrack.local",
    updatedAt: "2026-11-23T08:00:00Z",
  }));

  return { workers, assignments, payRules, teamDays, cookAttendance };
}

describe("Increment C — Work progress & overlap calculations (T05, T06)", () => {
  it("T05: Cut 0–500m then 250–750m yields 750m unique cutting, not 1,000m", () => {
    const merged = mergeIntervals([
      { start: 0, end: 500 },
      { start: 250, end: 750 },
    ]);
    expect(merged).toEqual([{ start: 0, end: 750 }]);

    const summary = calculateJobProgress(
      [BASE_SECTION],
      [
        makeProgress({ id: "p1", activity: "cutting", startChainageMeters: 0, endChainageMeters: 500 }),
        makeProgress({ id: "p2", activity: "cutting", startChainageMeters: 250, endChainageMeters: 750 }),
      ],
    );
    const cuttingMetric = summary.strips[0]?.activityMetrics.find((m) => m.activity === "cutting");
    expect(cuttingMetric?.uniqueCompletedMeters).toBe(750);
  });

  it("T06: Required cutting + removal; cutting 750m and removal 500m within it => only 500m fully completed", () => {
    const summary = calculateJobProgress(
      [BASE_SECTION],
      [
        makeProgress({ id: "p1", activity: "cutting", startChainageMeters: 0, endChainageMeters: 500 }),
        makeProgress({ id: "p2", activity: "cutting", startChainageMeters: 250, endChainageMeters: 750 }),
        makeProgress({ id: "p3", activity: "waste_collection", startChainageMeters: 100, endChainageMeters: 600 }),
      ],
    );
    expect(summary.fullyCompletedVergeMeters).toBe(500);
    expect(summary.fullyCompletedPhysicalAreaSqm).toBe(2500);
    expect(summary.fullyCompletedWeightedAreaSqm).toBe(3250); // 2500 * 1.30
    expect(summary.physicalPercent).toBe(50);
    expect(summary.effortWeightedPercent).toBe(50);
  });

  it("Excludes rework from completed area and flags out-of-scope chainage", () => {
    const conflict = detectProgressScopeConflict(BASE_SECTION, 900, 1200, "cutting");
    expect(conflict).toContain("outside approved section chainage");

    const summary = calculateJobProgress(
      [BASE_SECTION],
      [
        makeProgress({ id: "p-rework", activity: "cutting", startChainageMeters: 0, endChainageMeters: 400, isRework: true }),
        makeProgress({ id: "p-rem", activity: "waste_collection", startChainageMeters: 0, endChainageMeters: 400 }),
      ],
    );
    expect(summary.fullyCompletedVergeMeters).toBe(0);
    expect(summary.reworkEntryCount).toBe(1);
    expect(summary.reworkMeters).toBe(400);
  });
});

describe("Increment C — Weekly attendance & integer-cent payroll (T07–T11, T25)", () => {
  it("T07: 12 road workers × 5 days × R250 + cook R500 = R15,500 gross", () => {
    const fx = makeCrewFixture();
    const res = calculatePayrollWeek({
      weekStartDate: WEEK_START,
      jobId: SYNTHETIC_JOB_1,
      workers: fx.workers,
      roles: ROLES,
      assignments: fx.assignments,
      payRules: fx.payRules,
      rateOverrides: [],
      teamDays: fx.teamDays,
      attendanceEntries: fx.cookAttendance,
    });
    expect(res.canApprove).toBe(true);
    expect(res.grossTotalCents).toBe(1550000);
    expect(res.netTotalCents).toBe(1550000);
  });

  it("T08: Team loses 1 unpaid day; cook keeps full weekly R500 => R12,500; exceptions retained", () => {
    const fx = makeCrewFixture();
    // Friday becomes unpaid no_work for team
    fx.teamDays[4]!.dayStatus = "no_work";
    fx.teamDays[4]!.normalHours = 0;

    const res = calculatePayrollWeek({
      weekStartDate: WEEK_START,
      jobId: SYNTHETIC_JOB_1,
      workers: fx.workers,
      roles: ROLES,
      assignments: fx.assignments,
      payRules: fx.payRules,
      rateOverrides: [],
      teamDays: fx.teamDays,
      attendanceEntries: fx.cookAttendance,
    });
    expect(res.canApprove).toBe(true);
    expect(res.grossTotalCents).toBe(1250000);
  });

  it("T09: One worker absent one further unpaid day => R12,250", () => {
    const fx = makeCrewFixture();
    fx.teamDays[4]!.dayStatus = "no_work";
    fx.teamDays[4]!.normalHours = 0;

    const workerException: AttendanceEntry = {
      id: "ex-rw1-thu",
      businessId: SYNTHETIC_BIZ_A,
      jobId: SYNTHETIC_JOB_1,
      workerId: "rw-1",
      workDate: WEEK_DATES[3]!, // Thursday
      dayStatus: "no_work",
      normalHours: 0,
      weekdayOtHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      publicHolidayHours: 0,
      isOverride: true,
      overrideReason: "Unpaid absence",
      updatedByEmail: "owner@synthetic.worktrack.local",
      updatedAt: "2026-11-26T08:00:00Z",
    };

    const res = calculatePayrollWeek({
      weekStartDate: WEEK_START,
      jobId: SYNTHETIC_JOB_1,
      workers: fx.workers,
      roles: ROLES,
      assignments: fx.assignments,
      payRules: fx.payRules,
      rateOverrides: [],
      teamDays: fx.teamDays,
      attendanceEntries: [...fx.cookAttendance, workerException],
    });
    expect(res.grossTotalCents).toBe(1225000);
  });

  it("T10: Individual weekday OT, Saturday, and Sunday hours use distinct rate classes without double-counting normal hours", () => {
    const fx = makeCrewFixture();
    const singleWorker = [fx.workers[0]!];
    const singleAssign = [fx.assignments[0]!];
    const extras: AttendanceEntry[] = [
      {
        id: "ex-mon-ot",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workerId: "rw-1",
        workDate: WEEK_DATES[0]!, // Mon: 9h normal + 2h weekday OT (2 × R45 = R90)
        dayStatus: "worked",
        normalHours: 9,
        weekdayOtHours: 2,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        isOverride: true,
        overrideReason: "Late finish OT",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: "2026-11-23T18:00:00Z",
      },
      {
        id: "ex-sat",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workerId: "rw-1",
        workDate: WEEK_DATES[5]!, // Sat: 4h Saturday only (4 × R50 = R200), 0 normal
        dayStatus: "worked",
        normalHours: 0,
        weekdayOtHours: 0,
        saturdayHours: 4,
        sundayHours: 0,
        publicHolidayHours: 0,
        isOverride: true,
        overrideReason: "Saturday clearing",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: "2026-11-28T13:00:00Z",
      },
      {
        id: "ex-sun",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workerId: "rw-1",
        workDate: WEEK_DATES[6]!, // Sun: 3h Sunday only (3 × R60 = R180), 0 normal
        dayStatus: "worked",
        normalHours: 0,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 3,
        publicHolidayHours: 0,
        isOverride: true,
        overrideReason: "Emergency Sunday tidy",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: "2026-11-29T12:00:00Z",
      },
    ];

    const res = calculatePayrollWeek({
      weekStartDate: WEEK_START,
      jobId: SYNTHETIC_JOB_1,
      workers: singleWorker,
      roles: ROLES,
      assignments: singleAssign,
      payRules: fx.payRules,
      rateOverrides: [],
      teamDays: fx.teamDays,
      attendanceEntries: extras,
    });
    const line = res.earnings[0]!;
    expect(line.normalPayCents).toBe(125000); // 5 weekdays × R250 (Sat/Sun normal = 0)
    expect(line.weekdayOtPayCents).toBe(9000); // 2 × R45
    expect(line.saturdayPayCents).toBe(20000); // 4 × R50
    expect(line.sundayPayCents).toBe(18000); // 3 × R60
    expect(line.grossPayCents).toBe(172000);
  });

  it("T11: Midweek rate change applies old and new rates by effective date with both snapshots preserved", () => {
    const fx = makeCrewFixture();
    const splitRules: PayRule[] = [
      { ...fx.payRules[0]!, id: "pr-old", baseRateCents: 25000, effectiveFrom: "2026-11-01", effectiveTo: "2026-11-25" },
      { ...fx.payRules[0]!, id: "pr-new", baseRateCents: 30000, effectiveFrom: "2026-11-26", effectiveTo: null },
    ];
    const res = calculatePayrollWeek({
      weekStartDate: WEEK_START,
      jobId: SYNTHETIC_JOB_1,
      workers: [fx.workers[0]!],
      roles: ROLES,
      assignments: [fx.assignments[0]!],
      payRules: splitRules,
      rateOverrides: [],
      teamDays: fx.teamDays,
      attendanceEntries: [],
    });
    const line = res.earnings[0]!;
    // Mon–Wed (23, 24, 25) = 3 × R250 = R750; Thu–Fri (26, 27) = 2 × R300 = R600 => R1,350
    expect(line.normalPayCents).toBe(135000);
    expect(line.ruleSnapshots.length).toBe(2);
  });

  it("T25: Unknown attendance flags incomplete and blocks payroll approval (never defaults to 0 or 5 days)", () => {
    const fx = makeCrewFixture();
    fx.teamDays[4]!.dayStatus = "unknown";
    fx.teamDays[4]!.normalHours = 0;

    const issues = validateAttendanceWeek({
      weekStartDate: WEEK_START,
      jobId: SYNTHETIC_JOB_1,
      workers: [fx.workers[0]!],
      roles: ROLES,
      assignments: [fx.assignments[0]!],
      teamDays: fx.teamDays,
      attendanceEntries: [],
    });
    expect(issues.some((i) => i.severity === "warning" && i.message.includes("unknown"))).toBe(true);

    const calc = calculatePayrollWeek({
      weekStartDate: WEEK_START,
      jobId: SYNTHETIC_JOB_1,
      workers: [fx.workers[0]!],
      roles: ROLES,
      assignments: [fx.assignments[0]!],
      payRules: fx.payRules,
      rateOverrides: [],
      teamDays: fx.teamDays,
      attendanceEntries: [],
    });
    expect(calc.canApprove).toBe(false);
    expect(calc.earnings[0]?.hasUnknownAttendance).toBe(true);
  });

  it("Worker statement separates approved vs provisional earnings and preserves negative advance balances", () => {
    const fx = makeCrewFixture();
    const worker = { ...fx.workers[0]!, openingBalanceCents: -20000 }; // R200 advance
    const run: PayrollRun = {
      id: "run-1",
      businessId: SYNTHETIC_BIZ_A,
      jobId: SYNTHETIC_JOB_1,
      weekStartDate: WEEK_START,
      weekEndDate: WEEK_DATES[6]!,
      revision: 1,
      status: "approved",
      grossTotalCents: 125000,
      adjustmentsTotalCents: 0,
      deductionsTotalCents: 0,
      netTotalCents: 125000,
      earnings: [
        {
          id: "e1",
          workerId: worker.id,
          workerName: worker.fullName,
          roleName: "Road worker",
          roleType: "road_worker",
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
          missingRateReasons: [],
          ruleSnapshots: [],
        },
      ],
      adjustments: [],
      approvedByEmail: "admin@synthetic.worktrack.local",
      approvedAt: "2026-11-29T18:00:00Z",
      correctionReason: null,
      supersedesRunId: null,
      createdByEmail: "admin@synthetic.worktrack.local",
      createdAt: "2026-11-29T18:00:00Z",
    };

    const stmt = buildWorkerStatement(worker, "Road worker", [run], { "run-1": 150000 });
    // -20000 opening + 125000 approved - 150000 paid = -45000 (advance preserved)
    expect(stmt.closingBalanceCents).toBe(-45000);
  });
});

describe("Increment C — T21 Supervisor payroll denial & SQL migration integrity", () => {
  it("T21: Supervisor is denied reading or saving payroll runs", async () => {
    const supervisorSession: AuthSession = {
      userId: "u-sup-a",
      email: "supervisor@synthetic.worktrack.local",
      fullName: "Thabo Nkosi",
      businessId: SYNTHETIC_BIZ_A,
      businessName: "Karoo Verge Clearing",
      role: "supervisor",
      assignedJobIds: [SYNTHETIC_JOB_1],
      mode: "synthetic_dev",
    };
    await expect(listPayrollRuns(supervisorSession)).rejects.toThrow(/Access denied/i);
    await expect(
      savePayrollRunDraftOrApprove(supervisorSession, {
        jobId: SYNTHETIC_JOB_1,
        weekStartDate: WEEK_START,
        approve: false,
      }),
    ).rejects.toThrow(/Access denied/i);
  });

  it("Increment C SQL migration has GRANTs, RLS policies, immutability trigger, and no CASCADE delete on payroll tables", () => {
    const sql = fs.readFileSync(
      path.resolve("db/migrations/202611270004_increment_c_progress_attendance_payroll.sql"),
      "utf8",
    );
    const tables = [
      "progress_entries",
      "interruptions",
      "team_days",
      "attendance_entries",
      "payroll_runs",
      "payroll_earnings",
      "payroll_adjustments",
    ];
    for (const tbl of tables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${tbl}`);
      expect(sql).toContain(`ON public.${tbl} TO authenticated`);
      expect(sql).toContain(`ALTER TABLE public.${tbl} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ON public.${tbl}`);
    }
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).toContain("guard_approved_payroll_immutability");
    expect(sql).toContain("approve_payroll_run");
    expect(sql).toContain("SET search_path = public");
  });
});