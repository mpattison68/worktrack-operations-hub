import type { PayBasis, WorkerRoleType } from "@/lib/domain/types";
import type { ScopeActivity, VergeSide } from "@/lib/domain/assessment-types";

export type ProgressStageStatus = "in_progress" | "partial" | "complete";

export type ProgressSource = "manual" | "gps_snapped";

export type VerificationState = "reported" | "verified" | "flagged_conflict";

export interface ProgressEntry {
  id: string;
  businessId: string;
  jobId: string;
  sectionId: string;
  vergeSide: VergeSide;
  activity: ScopeActivity;
  reportedDate: string; // YYYY-MM-DD (SAST)
  startChainageMeters: number;
  endChainageMeters: number;
  stageStatus: ProgressStageStatus;
  isRework: boolean;
  source: ProgressSource;
  gpsAccuracyMeters: number | null;
  photoDate: string | null;
  evidenceNote: string;
  verificationState: VerificationState;
  conflictReason: string | null;
  submittedByEmail: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type DayWorkStatus = "unknown" | "worked" | "partial" | "no_work";

export type InterruptionReason =
  | "rain"
  | "vehicle"
  | "equipment"
  | "fuel"
  | "customer"
  | "public_holiday"
  | "other";

export const INTERRUPTION_REASON_LABELS: Record<InterruptionReason, string> = {
  rain: "Rain / weather",
  vehicle: "Vehicle breakdown",
  equipment: "Equipment breakdown",
  fuel: "Fuel shortage",
  customer: "Customer instruction / access",
  public_holiday: "Public holiday",
  other: "Other",
};

export interface InterruptionEntry {
  id: string;
  businessId: string;
  jobId: string;
  interruptionDate: string; // YYYY-MM-DD
  durationHours: number;
  fullDay: boolean;
  affectedCrewOrSection: string;
  reason: InterruptionReason;
  comment: string;
  submittedByEmail: string;
  createdAt: string;
}

export interface TeamDay {
  revision?: number;
  id: string;
  businessId: string;
  jobId: string;
  workDate: string; // YYYY-MM-DD
  dayStatus: DayWorkStatus;
  normalHours: number;
  weekdayOtHours: number;
  saturdayHours: number;
  sundayHours: number;
  publicHolidayHours: number;
  interruptionReason: InterruptionReason | null;
  notes: string;
  verificationState?: "reported" | "verified";
  updatedByEmail: string;
  updatedAt: string;
}

export interface AttendanceEntry {
  revision?: number;
  id: string;
  businessId: string;
  jobId: string;
  workerId: string;
  workDate: string; // YYYY-MM-DD
  dayStatus: DayWorkStatus;
  normalHours: number;
  weekdayOtHours: number;
  saturdayHours: number;
  sundayHours: number;
  publicHolidayHours: number;
  isOverride: boolean;
  overrideReason: string | null;
  verificationState?: "reported" | "verified";
  updatedByEmail: string;
  updatedAt: string;
}

export type PayrollRunStatus = "draft" | "approved" | "superseded";

export interface PayrollAdjustment {
  id: string;
  businessId: string;
  payrollRunId: string;
  workerId: string;
  kind: "allowance" | "bonus" | "statutory_deduction" | "correction";
  description: string;
  /** Positive adds to net pay, negative deducts from net pay (integer ZAR cents). */
  amountCents: number;
  approvedByEmail: string;
  createdAt: string;
}

export interface PayRuleSnapshot {
  payRuleId: string;
  overrideId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  payBasis: PayBasis;
  baseRateCents: number;
  normalHoursPerDay: number;
  normalWorkdaysPerWeek: number;
  weekdayOtHourlyCents: number | null;
  saturdayRateCents: number | null;
  sundayRateCents: number | null;
  publicHolidayRateCents: number | null;
  weeklyProrationPolicy: "full_week_entitlement" | "prorated_by_days" | "none";
  isConfirmed: boolean;
}

export interface PayrollEarningLine {
  id: string;
  workerId: string;
  workerName: string;
  roleName: string;
  roleType: WorkerRoleType;
  daysWorked: number;
  normalHours: number;
  weekdayOtHours: number;
  saturdayHours: number;
  sundayHours: number;
  publicHolidayHours: number;
  normalPayCents: number;
  weekdayOtPayCents: number;
  saturdayPayCents: number;
  sundayPayCents: number;
  publicHolidayPayCents: number;
  grossPayCents: number;
  adjustmentsCents: number;
  deductionsCents: number;
  netPayCents: number;
  hasUnknownAttendance: boolean;
  hasUnconfirmedRate: boolean;
  missingRateReasons: string[];
  ruleSnapshots: PayRuleSnapshot[];
}

export interface PayrollRun {
  id: string;
  businessId: string;
  jobId: string;
  weekStartDate: string; // Monday YYYY-MM-DD
  weekEndDate: string; // Sunday YYYY-MM-DD
  revision: number;
  status: PayrollRunStatus;
  grossTotalCents: number;
  adjustmentsTotalCents: number;
  deductionsTotalCents: number;
  netTotalCents: number;
  earnings: PayrollEarningLine[];
  adjustments: PayrollAdjustment[];
  approvedByEmail: string | null;
  approvedAt: string | null;
  correctionReason: string | null;
  supersedesRunId: string | null;
  createdByEmail: string;
  createdAt: string;
}

export interface WorkerStatementRow {
  weekStartDate: string;
  weekEndDate: string;
  payrollRunId: string;
  revision: number;
  status: PayrollRunStatus;
  daysWorked: number;
  normalHours: number;
  extraHours: number;
  rateSummary: string;
  grossEarnedCents: number;
  adjustmentsCents: number;
  deductionsCents: number;
  netEarnedCents: number;
  allocatedPaidCents: number;
  runningBalanceCents: number;
}

export interface WorkerStatement {
  workerId: string;
  workerName: string;
  roleName: string;
  openingBalanceCents: number;
  openingBalanceVerified: boolean;
  approvedNetTotalCents: number;
  provisionalNetTotalCents: number;
  allocatedPaymentsTotalCents: number;
  /** openingBalanceCents + approvedNetTotalCents - allocatedPaymentsTotalCents (negative = advance/credit) */
  closingBalanceCents: number;
  rows: WorkerStatementRow[];
}