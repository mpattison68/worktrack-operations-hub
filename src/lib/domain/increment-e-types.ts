export type AssetType = "truck" | "bakkie" | "trailer" | "brush_cutter" | "chainsaw" | "other";

export type AssetStatus = "available" | "unavailable_defect" | "in_service" | "retired";

export type CheckItemResult = "ok" | "problem" | "not_checked";

export type PreUseCheckItemKey =
  | "oil"
  | "coolant"
  | "leaks"
  | "tyres"
  | "brakes_lights"
  | "warning_lights";

export interface AssetRecord {
  id: string;
  businessId: string;
  assetType: AssetType;
  name: string;
  makeModel: string;
  registration: string | null;
  vin: string | null; // Restricted to admin/owner
  ownerName: string;
  purchaseCostCents: number | null;
  odometerKm: number | null;
  serviceIntervalKm: number | null;
  lastServiceOdometerKm: number | null;
  licenceExpiryDate: string | null;
  insuranceExpiryDate: string | null;
  assignedJobId: string | null;
  status: AssetStatus;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssetCheck {
  id: string;
  businessId: string;
  assetId: string;
  jobId: string | null;
  checkDate: string; // YYYY-MM-DD SAST
  odometerKm: number | null;
  items: Record<PreUseCheckItemKey, CheckItemResult>;
  stopUseTriggered: boolean;
  failedCriticalItems: PreUseCheckItemKey[];
  comment: string;
  photoNote: string | null;
  capturedOffline: boolean;
  syncStatus: "synced" | "queued_offline";
  checkedByUserId: string;
  checkedByName: string;
  createdAt: string;
  idempotencyKey?: string;
}

export type DefectStatus = "open" | "resolved";

export interface AssetDefect {
  id: string;
  businessId: string;
  assetId: string;
  checkId: string | null;
  severity: "critical" | "non_critical";
  summary: string;
  reportedDate: string;
  reportedByUserId: string;
  reportedByName: string;
  status: DefectStatus;
  resolutionNotes: string | null;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AssetServiceEntry {
  id: string;
  businessId: string;
  assetId: string;
  entryDate: string;
  entryType: "service" | "repair" | "fuel";
  odometerKm: number | null;
  litres: number | null;
  costCents: number;
  description: string;
  createdBy: string;
  createdAt: string;
}

export type WeeklyReportStatus = "draft" | "submitted" | "returned" | "approved";

export interface WeeklyReportCompleteness {
  hasProgressOrInterruption: boolean;
  attendanceConfirmed: boolean;
  unknownAttendanceCount: number;
  missingReceiptsCount: number;
  truckChecksCount: number;
  openCriticalDefectsCount: number;
  warnings: string[];
}

export interface WeeklyReportSnapshot {
  jobId: string;
  jobName: string;
  weekStart: string;
  weekEnd: string;
  assembledAt: string;
  // Operational (visible to all authorized roles)
  progressEntriesCount: number;
  weeklyClearedDistanceM: number;
  cumulativeCompletedPercent: number;
  effortWeightedPercent: number;
  interruptionsCount: number;
  interruptionHoursLost: number;
  interruptionReasons: string[];
  productiveWorkerDays: number;
  attendanceExceptionsCount: number;
  truckChecksCount: number;
  openCriticalDefectsCount: number;
  // Financial (restricted to admin & owner; zeroed/omitted for supervisor UI/exports)
  payrollRunId: string | null;
  payrollRunStatus: string | null;
  wagesEarnedCents: number;
  wagesPaidCents: number;
  priorArrearsCents: number;
  expensesIncurredCents: number;
  cashSpentCents: number;
  inflowsCents: number;
  missingReceiptsCount: number;
  completeness: WeeklyReportCompleteness;
  sourceIds: {
    progressIds: string[];
    interruptionIds: string[];
    payrollRunId: string | null;
    expenseIds: string[];
    checkIds: string[];
  };
}

export interface WeeklyReportRevision {
  id: string;
  reportId: string;
  revisionNumber: number;
  status: WeeklyReportStatus;
  snapshot: WeeklyReportSnapshot;
  actorUserId: string;
  actorName: string;
  comment: string | null;
  missingEvidenceAcknowledged: boolean;
  createdAt: string;
}

export interface WeeklyReport {
  id: string;
  businessId: string;
  jobId: string;
  weekStart: string; // Monday YYYY-MM-DD
  weekEnd: string; // Sunday YYYY-MM-DD
  status: WeeklyReportStatus;
  currentRevision: number;
  lockedSnapshot: WeeklyReportSnapshot | null;
  latestComment: string | null;
  missingEvidenceAcknowledged: boolean;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  revisions: WeeklyReportRevision[];
  createdAt: string;
  updatedAt: string;
}

export type NotificationSeverity = "info" | "warning" | "critical";

export type NotificationType =
  | "cash_shortfall"
  | "vehicle_stop_use"
  | "weekly_report_overdue"
  | "weekly_report_returned"
  | "expense_missing_receipt"
  | "expense_large"
  | "loan_repayment_due";

export interface NotificationRecord {
  id: string;
  businessId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  dedupKey: string;
  linkTo: string;
  readAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  deliveryChannel: "in_app" | "in_app_and_smtp_queued";
  createdAt: string;
}

export interface NotificationPreferences {
  businessId: string;
  weeklyReportReminderDay: "sunday" | "monday";
  weeklyReportReminderTimeSAST: string; // e.g. "17:00"
  largeExpenseThresholdCents: number;
  cashShortfallAlertEnabled: boolean;
  missingReceiptAlertEnabled: boolean;
  smtpDigestEnabled: boolean;
  smtpConfigured: boolean;
  updatedAt: string;
}

export interface IncrementEBundle {
  assets: AssetRecord[];
  checks: AssetCheck[];
  defects: AssetDefect[];
  services: AssetServiceEntry[];
  reports: WeeklyReport[];
  notifications: NotificationRecord[];
  preferences: NotificationPreferences;
}