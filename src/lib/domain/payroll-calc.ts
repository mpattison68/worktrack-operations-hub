import { addDays, format, parseISO } from "date-fns";
import type {
  PayRule,
  Worker,
  WorkerAssignment,
  WorkerRateOverride,
  WorkerRole,
} from "@/lib/domain/types";
import type {
  AttendanceEntry,
  DayWorkStatus,
  PayRuleSnapshot,
  PayrollAdjustment,
  PayrollEarningLine,
  PayrollRun,
  TeamDay,
  WorkerStatement,
  WorkerStatementRow,
} from "@/lib/domain/increment-c-types";
import { resolveEffectivePayRule } from "@/lib/domain/validation";
import { formatZarCents } from "@/lib/format";

/**
 * Return the 7 YYYY-MM-DD dates from Monday (weekStartDate) through Sunday.
 */
export function getWeekDates(weekStartDate: string): string[] {
  const start = parseISO(weekStartDate);
  return Array.from({ length: 7 }, (_, i) => format(addDays(start, i), "yyyy-MM-dd"));
}

/**
 * Resolve the effective pay rule snapshot for a worker on a given YYYY-MM-DD date,
 * merging any approved individual rate override effective on that date.
 */
export function resolveEffectiveRateForDate(
  worker: Worker,
  payRules: PayRule[],
  rateOverrides: WorkerRateOverride[],
  workDate: string,
): PayRuleSnapshot | null {
  const baseRule = resolveEffectivePayRule(payRules, worker.workerRoleId, workDate);
  const approvedOverride = rateOverrides.find(
    (o) =>
      o.workerId === worker.id &&
      o.status === "approved" &&
      o.effectiveFrom <= workDate &&
      (o.effectiveTo === null || o.effectiveTo >= workDate),
  );

  if (!baseRule && !approvedOverride) return null;

  if (approvedOverride && baseRule) {
    return {
      payRuleId: baseRule.id,
      overrideId: approvedOverride.id,
      effectiveFrom:
        approvedOverride.effectiveFrom > baseRule.effectiveFrom
          ? approvedOverride.effectiveFrom
          : baseRule.effectiveFrom,
      effectiveTo: approvedOverride.effectiveTo ?? baseRule.effectiveTo,
      payBasis: approvedOverride.payBasis,
      baseRateCents: approvedOverride.proposedRateCents,
      normalHoursPerDay: baseRule.normalHoursPerDay,
      normalWorkdaysPerWeek: baseRule.normalWorkdaysPerWeek,
      weekdayOtHourlyCents: baseRule.weekdayOtHourlyCents,
      saturdayRateCents: baseRule.saturdayRateCents,
      sundayRateCents: baseRule.sundayRateCents,
      publicHolidayRateCents: baseRule.publicHolidayRateCents,
      weeklyProrationPolicy: baseRule.weeklyProrationPolicy,
      isConfirmed: baseRule.isConfirmed,
    };
  }

  if (baseRule) {
    return {
      payRuleId: baseRule.id,
      overrideId: null,
      effectiveFrom: baseRule.effectiveFrom,
      effectiveTo: baseRule.effectiveTo,
      payBasis: baseRule.payBasis,
      baseRateCents: baseRule.baseRateCents,
      normalHoursPerDay: baseRule.normalHoursPerDay,
      normalWorkdaysPerWeek: baseRule.normalWorkdaysPerWeek,
      weekdayOtHourlyCents: baseRule.weekdayOtHourlyCents,
      saturdayRateCents: baseRule.saturdayRateCents,
      sundayRateCents: baseRule.sundayRateCents,
      publicHolidayRateCents: baseRule.publicHolidayRateCents,
      weeklyProrationPolicy: baseRule.weeklyProrationPolicy,
      isConfirmed: baseRule.isConfirmed,
    };
  }

  // Approved override without a base role rule
  return {
    payRuleId: "override-only",
    overrideId: approvedOverride!.id,
    effectiveFrom: approvedOverride!.effectiveFrom,
    effectiveTo: approvedOverride!.effectiveTo,
    payBasis: approvedOverride!.payBasis,
    baseRateCents: approvedOverride!.proposedRateCents,
    normalHoursPerDay: 9,
    normalWorkdaysPerWeek: 5,
    weekdayOtHourlyCents: null,
    saturdayRateCents: null,
    sundayRateCents: null,
    publicHolidayRateCents: null,
    weeklyProrationPolicy: "none",
    isConfirmed: true,
  };
}

export interface EffectiveWorkerDay {
  workDate: string;
  dayStatus: DayWorkStatus;
  normalHours: number;
  weekdayOtHours: number;
  saturdayHours: number;
  sundayHours: number;
  publicHolidayHours: number;
  isOverride: boolean;
  overrideReason: string | null;
}

/**
 * Resolve a worker's effective attendance for a specific date:
 * - Explicit worker AttendanceEntry always wins (preserves individual exceptions).
 * - Otherwise, if the worker's role shares crew schedule, inherits the job's TeamDay.
 * - Otherwise remains "unknown" (never silently defaults to 0 or 5 days).
 */
export function resolveEffectiveWorkerDay(
  workDate: string,
  workerEntry: AttendanceEntry | undefined,
  teamDay: TeamDay | undefined,
  sharesCrewSchedule: boolean,
): EffectiveWorkerDay {
  if (workerEntry) {
    return {
      workDate,
      dayStatus: workerEntry.dayStatus,
      normalHours: workerEntry.normalHours,
      weekdayOtHours: workerEntry.weekdayOtHours,
      saturdayHours: workerEntry.saturdayHours,
      sundayHours: workerEntry.sundayHours,
      publicHolidayHours: workerEntry.publicHolidayHours,
      isOverride: workerEntry.isOverride,
      overrideReason: workerEntry.overrideReason,
    };
  }

  if (sharesCrewSchedule && teamDay) {
    return {
      workDate,
      dayStatus: teamDay.dayStatus,
      normalHours: teamDay.normalHours,
      weekdayOtHours: teamDay.weekdayOtHours,
      saturdayHours: teamDay.saturdayHours,
      sundayHours: teamDay.sundayHours,
      publicHolidayHours: teamDay.publicHolidayHours,
      isOverride: false,
      overrideReason: null,
    };
  }

  return {
    workDate,
    dayStatus: "unknown",
    normalHours: 0,
    weekdayOtHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    publicHolidayHours: 0,
    isOverride: false,
    overrideReason: null,
  };
}

export function validateAttendanceEntryHours(input: {
  normalHours: number;
  weekdayOtHours: number;
  saturdayHours: number;
  sundayHours: number;
  publicHolidayHours: number;
}): string | null {
  const fields = [
    input.normalHours,
    input.weekdayOtHours,
    input.saturdayHours,
    input.sundayHours,
    input.publicHolidayHours,
  ];
  if (fields.some((h) => !Number.isFinite(h) || h < 0)) {
    return "Hours cannot be negative.";
  }
  const total = fields.reduce((s, h) => s + h, 0);
  if (total > 24) {
    return `Total hours for a single day (${total}h) cannot exceed 24 hours.`;
  }
  return null;
}

export interface AttendanceValidationIssue {
  workerId: string;
  workerName: string;
  workDate: string;
  severity: "error" | "warning";
  message: string;
}

export function validateAttendanceWeek(params: {
  weekStartDate: string;
  jobId: string;
  workers: Worker[];
  roles: WorkerRole[];
  assignments: WorkerAssignment[];
  teamDays: TeamDay[];
  attendanceEntries: AttendanceEntry[];
  otherJobAttendance?: AttendanceEntry[];
}): AttendanceValidationIssue[] {
  const issues: AttendanceValidationIssue[] = [];
  const dates = getWeekDates(params.weekStartDate);
  const weekEndDate = dates[6]!;
  const roleMap = new Map(params.roles.map((r) => [r.id, r]));
  const teamByDate = new Map(
    params.teamDays
      .filter((t) => t.jobId === params.jobId)
      .map((t) => [t.workDate, t]),
  );

  const assignedWorkers = params.workers.filter((w) =>
    params.assignments.some(
      (a) =>
        a.workerId === w.id &&
        a.jobId === params.jobId &&
        a.assignedFrom <= weekEndDate &&
        (a.assignedTo === null || a.assignedTo >= params.weekStartDate),
    ),
  );

  for (const worker of assignedWorkers) {
    const role = roleMap.get(worker.workerRoleId);
    const sharesCrew = role?.sharesCrewSchedule ?? true;
    const assignment = params.assignments.find(
      (a) =>
        a.workerId === worker.id &&
        a.jobId === params.jobId &&
        a.assignedFrom <= weekEndDate &&
        (a.assignedTo === null || a.assignedTo >= params.weekStartDate),
    );

    for (const workDate of dates) {
      const entry = params.attendanceEntries.find(
        (e) => e.workerId === worker.id && e.jobId === params.jobId && e.workDate === workDate,
      );
      const effective = resolveEffectiveWorkerDay(
        workDate,
        entry,
        teamByDate.get(workDate),
        sharesCrew,
      );

      const hoursErr = validateAttendanceEntryHours(effective);
      if (hoursErr) {
        issues.push({
          workerId: worker.id,
          workerName: worker.fullName,
          workDate,
          severity: "error",
          message: hoursErr,
        });
      }

      const isWorked = effective.dayStatus === "worked" || effective.dayStatus === "partial";
      if (isWorked && assignment) {
        if (
          workDate < assignment.assignedFrom ||
          (assignment.assignedTo !== null && workDate > assignment.assignedTo)
        ) {
          issues.push({
            workerId: worker.id,
            workerName: worker.fullName,
            workDate,
            severity: "error",
            message: `Worked date ${workDate} is outside job assignment dates.`,
          });
        }
      }

      if (isWorked && params.otherJobAttendance) {
        const conflict = params.otherJobAttendance.find(
          (o) =>
            o.workerId === worker.id &&
            o.jobId !== params.jobId &&
            o.workDate === workDate &&
            (o.dayStatus === "worked" || o.dayStatus === "partial"),
        );
        if (conflict) {
          issues.push({
            workerId: worker.id,
            workerName: worker.fullName,
            workDate,
            severity: "error",
            message: `Overlapping attendance recorded on another job on ${workDate}.`,
          });
        }
      }

      if (effective.dayStatus === "unknown" && worker.active) {
        issues.push({
          workerId: worker.id,
          workerName: worker.fullName,
          workDate,
          severity: "warning",
          message: `Attendance is unknown on ${workDate} — confirm worked, partial, or no work before payroll approval.`,
        });
      }
    }
  }

  return issues;
}

export interface PayrollCalculationResult {
  weekStartDate: string;
  weekEndDate: string;
  earnings: PayrollEarningLine[];
  grossTotalCents: number;
  adjustmentsTotalCents: number;
  deductionsTotalCents: number;
  netTotalCents: number;
  canApprove: boolean;
  blockingReasons: string[];
}

/**
 * Deterministic integer-cent payroll calculator for a Mon–Sun job week.
 * Mirrors the server-side SQL calculation rules in db/migrations/202611270004.
 */
export function calculatePayrollWeek(params: {
  weekStartDate: string;
  jobId: string;
  workers: Worker[];
  roles: WorkerRole[];
  assignments: WorkerAssignment[];
  payRules: PayRule[];
  rateOverrides: WorkerRateOverride[];
  teamDays: TeamDay[];
  attendanceEntries: AttendanceEntry[];
  adjustments?: PayrollAdjustment[];
  requireConfirmedRatesForApproval?: boolean;
}): PayrollCalculationResult {
  const dates = getWeekDates(params.weekStartDate);
  const weekEndDate = dates[6]!;
  const roleMap = new Map(params.roles.map((r) => [r.id, r]));
  const teamByDate = new Map(
    params.teamDays
      .filter((t) => t.jobId === params.jobId)
      .map((t) => [t.workDate, t]),
  );
  const requireConfirmed = params.requireConfirmedRatesForApproval ?? true;

  const eligibleWorkers = params.workers.filter((w) =>
    params.assignments.some(
      (a) =>
        a.workerId === w.id &&
        a.jobId === params.jobId &&
        a.assignedFrom <= weekEndDate &&
        (a.assignedTo === null || a.assignedTo >= params.weekStartDate),
    ),
  );

  const earnings: PayrollEarningLine[] = [];
  const blockingReasons: string[] = [];

  for (const worker of eligibleWorkers) {
    const role = roleMap.get(worker.workerRoleId);
    const sharesCrew = role?.sharesCrewSchedule ?? true;

    let daysWorked = 0;
    let normalHours = 0;
    let weekdayOtHours = 0;
    let saturdayHours = 0;
    let sundayHours = 0;
    let publicHolidayHours = 0;

    let normalPayCents = 0;
    let weekdayOtPayCents = 0;
    let saturdayPayCents = 0;
    let sundayPayCents = 0;
    let publicHolidayPayCents = 0;

    let hasUnknownAttendance = false;
    let hasUnconfirmedRate = false;
    const missingRateReasons = new Set<string>();
    const snapshotMap = new Map<string, PayRuleSnapshot>();

    const dailyEffective: Array<{ day: EffectiveWorkerDay; snap: PayRuleSnapshot | null }> = [];

    for (const workDate of dates) {
      const entry = params.attendanceEntries.find(
        (e) => e.workerId === worker.id && e.jobId === params.jobId && e.workDate === workDate,
      );
      const day = resolveEffectiveWorkerDay(
        workDate,
        entry,
        teamByDate.get(workDate),
        sharesCrew,
      );
      const snap = resolveEffectiveRateForDate(
        worker,
        params.payRules,
        params.rateOverrides,
        workDate,
      );
      dailyEffective.push({ day, snap });

      if (day.dayStatus === "unknown") {
        hasUnknownAttendance = true;
      }

      if (snap) {
        const snapKey = `${snap.payRuleId}:${snap.overrideId ?? "none"}:${snap.effectiveFrom}`;
        if (!snapshotMap.has(snapKey)) snapshotMap.set(snapKey, snap);
        if (!snap.isConfirmed) hasUnconfirmedRate = true;
      } else if (day.dayStatus === "worked" || day.dayStatus === "partial") {
        missingRateReasons.add(`No effective pay rule on ${workDate}.`);
      }

      if (day.dayStatus === "worked" || day.dayStatus === "partial") {
        const denom = snap?.normalHoursPerDay ?? 9;
        const dayFrac = denom > 0 ? Math.min(1, day.normalHours / denom) : 0;
        daysWorked += dayFrac;
      }

      normalHours += day.normalHours;
      weekdayOtHours += day.weekdayOtHours;
      saturdayHours += day.saturdayHours;
      sundayHours += day.sundayHours;
      publicHolidayHours += day.publicHolidayHours;

      // Normal pay for daily & hourly bases is computed per day (supports midweek effective-date splits — T11)
      if (snap && (day.dayStatus === "worked" || day.dayStatus === "partial")) {
        if (snap.payBasis === "daily") {
          const fraction =
            snap.normalHoursPerDay > 0
              ? Math.min(1, day.normalHours / snap.normalHoursPerDay)
              : 0;
          normalPayCents += Math.round(snap.baseRateCents * fraction);
        } else if (snap.payBasis === "hourly") {
          normalPayCents += Math.round(snap.baseRateCents * day.normalHours);
        }
      }

      // Mutually exclusive OT / weekend / public holiday classes (no double-counting of normal hours — T10)
      if (day.weekdayOtHours > 0) {
        if (snap?.weekdayOtHourlyCents != null) {
          weekdayOtPayCents += Math.round(day.weekdayOtHours * snap.weekdayOtHourlyCents);
        } else {
          missingRateReasons.add(`Weekday OT rate not configured for ${workDate}.`);
        }
      }
      if (day.saturdayHours > 0) {
        if (snap?.saturdayRateCents != null) {
          saturdayPayCents += Math.round(day.saturdayHours * snap.saturdayRateCents);
        } else {
          missingRateReasons.add(`Saturday rate not configured for ${workDate}.`);
        }
      }
      if (day.sundayHours > 0) {
        if (snap?.sundayRateCents != null) {
          sundayPayCents += Math.round(day.sundayHours * snap.sundayRateCents);
        } else {
          missingRateReasons.add(`Sunday rate not configured for ${workDate}.`);
        }
      }
      if (day.publicHolidayHours > 0) {
        if (snap?.publicHolidayRateCents != null) {
          publicHolidayPayCents += Math.round(
            day.publicHolidayHours * snap.publicHolidayRateCents,
          );
        } else {
          missingRateReasons.add(`Public holiday rate not configured for ${workDate}.`);
        }
      }
    }

    // Weekly pay basis calculation (supports full_week_entitlement, prorated_by_days, and midweek rate changes)
    const weeklyDays = dailyEffective.filter((d) => d.snap?.payBasis === "weekly");
    if (weeklyDays.length > 0) {
      const distinctWeeklySnaps = new Map<string, { snap: PayRuleSnapshot; dayCount: number }>();
      for (const item of weeklyDays) {
        const s = item.snap!;
        const key = `${s.payRuleId}:${s.overrideId ?? "none"}:${s.effectiveFrom}`;
        const prev = distinctWeeklySnaps.get(key);
        if (prev) prev.dayCount += 1;
        else distinctWeeklySnaps.set(key, { snap: s, dayCount: 1 });
      }

      const hasAnyConfirmedWorkedOrPartial = dailyEffective.some(
        (d) => d.day.dayStatus === "worked" || d.day.dayStatus === "partial",
      );
      const allNoWork = dailyEffective.every((d) => d.day.dayStatus === "no_work");

      for (const { snap, dayCount } of distinctWeeklySnaps.values()) {
        const segmentWeight = distinctWeeklySnaps.size === 1 ? 1 : dayCount / 7;
        if (snap.weeklyProrationPolicy === "full_week_entitlement") {
          if (!allNoWork && !hasUnknownAttendance) {
            normalPayCents += Math.round(snap.baseRateCents * segmentWeight);
          } else if (hasAnyConfirmedWorkedOrPartial) {
            normalPayCents += Math.round(snap.baseRateCents * segmentWeight);
          }
        } else if (snap.weeklyProrationPolicy === "prorated_by_days") {
          const ratio =
            snap.normalWorkdaysPerWeek > 0
              ? Math.min(1, daysWorked / snap.normalWorkdaysPerWeek)
              : 0;
          normalPayCents += Math.round(snap.baseRateCents * ratio * segmentWeight);
        } else if (hasAnyConfirmedWorkedOrPartial) {
          normalPayCents += Math.round(snap.baseRateCents * segmentWeight);
        }
      }
    }

    const grossPayCents =
      normalPayCents +
      weekdayOtPayCents +
      saturdayPayCents +
      sundayPayCents +
      publicHolidayPayCents;

    const workerAdj = (params.adjustments ?? []).filter((a) => a.workerId === worker.id);
    let adjustmentsCents = 0;
    let deductionsCents = 0;
    for (const adj of workerAdj) {
      if (adj.amountCents >= 0) adjustmentsCents += adj.amountCents;
      else deductionsCents += Math.abs(adj.amountCents);
    }
    const netPayCents = grossPayCents + adjustmentsCents - deductionsCents;

    if (hasUnknownAttendance) {
      blockingReasons.push(`${worker.fullName} has unknown attendance days in this week.`);
    }
    if (requireConfirmed && hasUnconfirmedRate) {
      blockingReasons.push(
        `${worker.fullName} uses an unconfirmed pay rule — Admin must confirm rates before approval.`,
      );
    }
    if (missingRateReasons.size > 0) {
      blockingReasons.push(
        `${worker.fullName}: ${Array.from(missingRateReasons).join(" ")}`,
      );
    }

    earnings.push({
      id: `earn-${worker.id}-${params.weekStartDate}`,
      workerId: worker.id,
      workerName: worker.fullName,
      roleName: role?.name ?? "Unknown role",
      roleType: role?.roleType ?? "other",
      daysWorked: Number(daysWorked.toFixed(2)),
      normalHours: Number(normalHours.toFixed(2)),
      weekdayOtHours: Number(weekdayOtHours.toFixed(2)),
      saturdayHours: Number(saturdayHours.toFixed(2)),
      sundayHours: Number(sundayHours.toFixed(2)),
      publicHolidayHours: Number(publicHolidayHours.toFixed(2)),
      normalPayCents,
      weekdayOtPayCents,
      saturdayPayCents,
      sundayPayCents,
      publicHolidayPayCents,
      grossPayCents,
      adjustmentsCents,
      deductionsCents,
      netPayCents,
      hasUnknownAttendance,
      hasUnconfirmedRate,
      missingRateReasons: Array.from(missingRateReasons),
      ruleSnapshots: Array.from(snapshotMap.values()),
    });
  }

  const grossTotalCents = earnings.reduce((s, e) => s + e.grossPayCents, 0);
  const adjustmentsTotalCents = earnings.reduce((s, e) => s + e.adjustmentsCents, 0);
  const deductionsTotalCents = earnings.reduce((s, e) => s + e.deductionsCents, 0);
  const netTotalCents = earnings.reduce((s, e) => s + e.netPayCents, 0);

  if (earnings.length === 0) {
    blockingReasons.push("No assigned workers found for this job and week.");
  }

  return {
    weekStartDate: params.weekStartDate,
    weekEndDate,
    earnings,
    grossTotalCents,
    adjustmentsTotalCents,
    deductionsTotalCents,
    netTotalCents,
    canApprove: blockingReasons.length === 0,
    blockingReasons,
  };
}

/**
 * Build a chronological worker earnings & balance statement across payroll runs.
 * Excludes superseded runs; separates approved vs provisional earnings; preserves negative (advance) balances.
 */
export function buildWorkerStatement(
  worker: Worker,
  roleName: string,
  payrollRuns: PayrollRun[],
  allocatedPaymentsByRunId: Record<string, number> = {},
  unallocatedAdvanceCents = 0,
): WorkerStatement {
  const activeRuns = payrollRuns
    .filter((r) => r.status !== "superseded")
    .sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));

  let runningBalance = worker.openingBalanceCents;
  let approvedNetTotalCents = 0;
  let provisionalNetTotalCents = 0;
  let allocatedPaymentsTotalCents = 0;
  const rows: WorkerStatementRow[] = [];

  for (const run of activeRuns) {
    const line = run.earnings.find((e) => e.workerId === worker.id);
    if (!line) continue;

    const paidCents = allocatedPaymentsByRunId[run.id] ?? 0;
    allocatedPaymentsTotalCents += paidCents;

    if (run.status === "approved") {
      approvedNetTotalCents += line.netPayCents;
      runningBalance += line.netPayCents - paidCents;
    } else {
      provisionalNetTotalCents += line.netPayCents;
      runningBalance -= paidCents;
    }

    const rateSummary =
      line.ruleSnapshots.length === 0
        ? "No rate"
        : line.ruleSnapshots
            .map((s) => `${formatZarCents(s.baseRateCents)}/${s.payBasis}`)
            .join(" → ");

    rows.push({
      weekStartDate: run.weekStartDate,
      weekEndDate: run.weekEndDate,
      payrollRunId: run.id,
      revision: run.revision,
      status: run.status,
      daysWorked: line.daysWorked,
      normalHours: line.normalHours,
      extraHours: Number(
        (
          line.weekdayOtHours +
          line.saturdayHours +
          line.sundayHours +
          line.publicHolidayHours
        ).toFixed(2),
      ),
      rateSummary,
      grossEarnedCents: line.grossPayCents,
      adjustmentsCents: line.adjustmentsCents,
      deductionsCents: line.deductionsCents,
      netEarnedCents: line.netPayCents,
      allocatedPaidCents: paidCents,
      runningBalanceCents: runningBalance,
    });
  }

  const totalPaymentsIncludingAdvances = allocatedPaymentsTotalCents + unallocatedAdvanceCents;
  const closingBalanceCents =
    worker.openingBalanceCents + approvedNetTotalCents - totalPaymentsIncludingAdvances;

  return {
    workerId: worker.id,
    workerName: worker.fullName,
    roleName,
    openingBalanceCents: worker.openingBalanceCents,
    openingBalanceVerified: worker.openingBalanceVerified,
    approvedNetTotalCents,
    provisionalNetTotalCents,
    allocatedPaymentsTotalCents: totalPaymentsIncludingAdvances,
    closingBalanceCents,
    rows,
  };
}