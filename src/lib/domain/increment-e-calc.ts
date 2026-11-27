import type { Job, Worker } from "@/lib/domain/types";
import type {
  AttendanceEntry,
  InterruptionEntry,
  PayrollRun,
  ProgressEntry,
  TeamDay,
} from "@/lib/domain/increment-c-types";
import type {
  ExpenseRecord,
  FinanceBundle,
  WagePayment,
  WeeklyCashForecastResult,
} from "@/lib/domain/increment-d-types";
import type {
  AssetCheck,
  AssetDefect,
  AssetServiceEntry,
  CheckItemResult,
  NotificationPreferences,
  NotificationRecord,
  PreUseCheckItemKey,
  WeeklyReport,
  WeeklyReportSnapshot,
} from "@/lib/domain/increment-e-types";
import { formatDateSA, formatZarCents } from "@/lib/format";

export const PRE_USE_CHECK_ITEMS: Array<{
  key: PreUseCheckItemKey;
  label: string;
  critical: boolean;
}> = [
  { key: "oil", label: "Engine oil level & pressure", critical: true },
  { key: "coolant", label: "Coolant level & hoses", critical: true },
  { key: "leaks", label: "Fluid leaks under vehicle", critical: false },
  { key: "tyres", label: "Tyres, tread & wheel nuts", critical: true },
  { key: "brakes_lights", label: "Brakes, indicators & lights", critical: true },
  { key: "warning_lights", label: "Dashboard warning lights", critical: true },
];

/**
 * Evaluate a daily pre-use safety checklist (spec Section 14, T22).
 * Any safety-critical item marked "problem" or "not_checked", or leaks marked "problem",
 * triggers immediate STOP DO NOT USE.
 */
export function evaluatePreUseCheck(
  items: Record<PreUseCheckItemKey, CheckItemResult>,
): {
  stopUseTriggered: boolean;
  failedCriticalItems: PreUseCheckItemKey[];
  summary: string;
} {
  const failed: PreUseCheckItemKey[] = [];
  for (const def of PRE_USE_CHECK_ITEMS) {
    const result = items[def.key];
    if (def.critical && (result === "problem" || result === "not_checked")) {
      failed.push(def.key);
    } else if (!def.critical && result === "problem") {
      failed.push(def.key);
    }
  }
  const stopUseTriggered = failed.length > 0;
  const labels = failed
    .map((k) => PRE_USE_CHECK_ITEMS.find((i) => i.key === k)?.label ?? k)
    .join(", ");
  const summary = stopUseTriggered
    ? `Critical pre-use check failure: ${labels}`
    : "All pre-use safety items OK";
  return { stopUseTriggered, failedCriticalItems: failed, summary };
}

/**
 * Calculate actual fill-to-fill fuel consumption (L/100km) when >= 2 consecutive fuel
 * entries have strictly increasing odometer readings and litres > 0.
 * Otherwise returns an explicit estimate flag per spec Section 14.
 */
export function calculateAssetFuelConsumption(services: AssetServiceEntry[]): {
  litresPer100Km: number | null;
  totalLitres: number;
  totalFuelCostCents: number;
  isActualFillToFill: boolean;
  label: string;
} {
  const fuelEntries = services
    .filter((s) => s.entryType === "fuel")
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate));

  const totalLitres = fuelEntries.reduce((sum, e) => sum + (e.litres ?? 0), 0);
  const totalFuelCostCents = fuelEntries.reduce((sum, e) => sum + e.costCents, 0);

  const withOdo = fuelEntries.filter(
    (e): e is AssetServiceEntry & { odometerKm: number; litres: number } =>
      e.odometerKm !== null && e.litres !== null && e.litres > 0,
  );

  if (withOdo.length >= 2) {
    const first = withOdo[0]!;
    const last = withOdo[withOdo.length - 1]!;
    const distanceKm = last.odometerKm - first.odometerKm;
    // Exclude the initial fill's litres since distance is measured from first fill to last fill
    const consumedLitres = withOdo.slice(1).reduce((sum, e) => sum + e.litres, 0);
    if (distanceKm > 0 && consumedLitres > 0) {
      const lPer100 = Math.round((consumedLitres / distanceKm) * 1000) / 10;
      return {
        litresPer100Km: lPer100,
        totalLitres: Math.round(totalLitres * 10) / 10,
        totalFuelCostCents,
        isActualFillToFill: true,
        label: `${lPer100.toFixed(1)} L/100km (Actual fill-to-fill)`,
      };
    }
  }

  return {
    litresPer100Km: null,
    totalLitres: Math.round(totalLitres * 10) / 10,
    totalFuelCostCents,
    isActualFillToFill: false,
    label: "Insufficient comparable fills (Estimated / unverified)",
  };
}

function inWeek(dateStr: string, weekStart: string, weekEnd: string): boolean {
  return dateStr >= weekStart && dateStr <= weekEnd;
}

export interface AssembleWeeklyReportParams {
  job: Job;
  weekStart: string;
  weekEnd: string;
  progressEntries: ProgressEntry[];
  cumulativeCompletedPercent: number;
  effortWeightedPercent: number;
  interruptions: InterruptionEntry[];
  teamDays: TeamDay[];
  attendanceEntries: AttendanceEntry[];
  payrollRuns: PayrollRun[];
  wagePayments: WagePayment[];
  workers: Worker[];
  expenses: ExpenseRecord[];
  financeBundle: FinanceBundle;
  checks: AssetCheck[];
  defects: AssetDefect[];
}

/**
 * Auto-assemble a Mon-Sun weekly job report snapshot (spec Section 12, T18).
 * Picks at most one authoritative payroll run (latest approved, else latest draft)
 * so payroll is never duplicated across revisions.
 */
export function assembleWeeklyReportSnapshot(
  params: AssembleWeeklyReportParams,
): WeeklyReportSnapshot {
  const { job, weekStart, weekEnd } = params;

  const weekProgress = params.progressEntries.filter(
    (p) => p.jobId === job.id && inWeek(p.reportedDate, weekStart, weekEnd),
  );
  const weeklyClearedDistanceM = weekProgress
    .filter((p) => !p.isRework)
    .reduce((sum, p) => sum + Math.max(0, p.endChainageMeters - p.startChainageMeters), 0);

  const weekInterruptions = params.interruptions.filter(
    (i) => i.jobId === job.id && inWeek(i.interruptionDate, weekStart, weekEnd),
  );
  const interruptionHoursLost = weekInterruptions.reduce((sum, i) => sum + i.durationHours, 0);
  const interruptionReasons = Array.from(new Set(weekInterruptions.map((i) => i.reason)));

  const weekTeamDays = params.teamDays.filter(
    (t) => t.jobId === job.id && inWeek(t.workDate, weekStart, weekEnd),
  );
  const weekAttendance = params.attendanceEntries.filter(
    (a) => a.jobId === job.id && inWeek(a.workDate, weekStart, weekEnd),
  );
  const unknownAttendanceCount =
    weekTeamDays.filter((t) => t.dayStatus === "unknown").length +
    weekAttendance.filter((a) => a.dayStatus === "unknown").length;
  const attendanceExceptionsCount = weekAttendance.filter((a) => a.isOverride).length;

  // Select single authoritative payroll run for this job+week (avoid duplicate payroll)
  const matchingRuns = params.payrollRuns
    .filter((r) => r.jobId === job.id && r.weekStartDate === weekStart && r.status !== "superseded")
    .sort((a, b) => b.revision - a.revision);
  const activeRun =
    matchingRuns.find((r) => r.status === "approved") ?? matchingRuns[0] ?? null;

  const productiveWorkerDays = activeRun
    ? activeRun.earnings.reduce((sum, e) => sum + e.daysWorked, 0)
    : weekAttendance.filter((a) => a.dayStatus === "worked" || a.dayStatus === "partial").length;

  const wagesEarnedCents = activeRun?.netTotalCents ?? 0;
  const weekWagePayments = params.wagePayments.filter(
    (wp) =>
      (wp.jobId === job.id || wp.jobId === null) &&
      inWeek(wp.paymentDate, weekStart, weekEnd),
  );
  const wagesPaidCents = weekWagePayments.reduce((sum, wp) => sum + wp.totalAmountCents, 0);
  const priorArrearsCents = params.workers
    .filter((w) => w.openingBalanceCents > 0)
    .reduce((sum, w) => sum + w.openingBalanceCents, 0);

  const weekExpenses = params.expenses.filter(
    (e) => (e.jobId === job.id || e.jobId === null) && inWeek(e.expenseDate, weekStart, weekEnd),
  );
  const expensesIncurredCents = weekExpenses.reduce((sum, e) => sum + e.amountCents, 0);
  const cashSpentCents =
    wagesPaidCents + weekExpenses.reduce((sum, e) => sum + e.paidAmountCents, 0);
  const missingReceiptsCount = weekExpenses.filter((e) => e.receiptAttachment === null).length;

  const weekInflowsCents = params.financeBundle.milestones
    .filter(
      (m) =>
        m.jobId === job.id &&
        m.receivedDate !== null &&
        inWeek(m.receivedDate, weekStart, weekEnd),
    )
    .reduce((sum, m) => sum + m.receivedAmountCents, 0);

  const weekChecks = params.checks.filter(
    (c) => (c.jobId === job.id || c.jobId === null) && inWeek(c.checkDate, weekStart, weekEnd),
  );
  const openCriticalDefectsCount = params.defects.filter(
    (d) => d.status === "open" && d.severity === "critical",
  ).length;

  const warnings: string[] = [];
  if (weekProgress.length === 0 && weekInterruptions.length === 0) {
    warnings.push("No work progress or interruption logged for this week.");
  }
  if (unknownAttendanceCount > 0) {
    warnings.push(`${unknownAttendanceCount} attendance day(s) still marked unknown.`);
  }
  if (missingReceiptsCount > 0) {
    warnings.push(`${missingReceiptsCount} expense(s) recorded without a receipt photo.`);
  }
  if (weekChecks.length === 0) {
    warnings.push("No daily vehicle pre-use check logged for this week.");
  }
  if (openCriticalDefectsCount > 0) {
    warnings.push(`${openCriticalDefectsCount} open critical vehicle defect(s) active.`);
  }

  return {
    jobId: job.id,
    jobName: job.name,
    weekStart,
    weekEnd,
    assembledAt: new Date().toISOString(),
    progressEntriesCount: weekProgress.length,
    weeklyClearedDistanceM: Math.round(weeklyClearedDistanceM),
    cumulativeCompletedPercent: Math.round(params.cumulativeCompletedPercent * 10) / 10,
    effortWeightedPercent: Math.round(params.effortWeightedPercent * 10) / 10,
    interruptionsCount: weekInterruptions.length,
    interruptionHoursLost: Math.round(interruptionHoursLost * 10) / 10,
    interruptionReasons,
    productiveWorkerDays,
    attendanceExceptionsCount,
    truckChecksCount: weekChecks.length,
    openCriticalDefectsCount,
    payrollRunId: activeRun?.id ?? null,
    payrollRunStatus: activeRun?.status ?? null,
    wagesEarnedCents,
    wagesPaidCents,
    priorArrearsCents,
    expensesIncurredCents,
    cashSpentCents,
    inflowsCents: weekInflowsCents,
    missingReceiptsCount,
    completeness: {
      hasProgressOrInterruption: weekProgress.length > 0 || weekInterruptions.length > 0,
      attendanceConfirmed: unknownAttendanceCount === 0,
      unknownAttendanceCount,
      missingReceiptsCount,
      truckChecksCount: weekChecks.length,
      openCriticalDefectsCount,
      warnings,
    },
    sourceIds: {
      progressIds: weekProgress.map((p) => p.id),
      interruptionIds: weekInterruptions.map((i) => i.id),
      payrollRunId: activeRun?.id ?? null,
      expenseIds: weekExpenses.map((e) => e.id),
      checkIds: weekChecks.map((c) => c.id),
    },
  };
}

/**
 * Evaluate live business state into deduplicated notifications (spec Section 13).
 */
export function evaluateBusinessAlerts(params: {
  businessId: string;
  preferences: NotificationPreferences;
  defects: AssetDefect[];
  reports: WeeklyReport[];
  expenses: ExpenseRecord[];
  forecast: WeeklyCashForecastResult | null;
  loanBalanceCents: number;
  existingNotifications: NotificationRecord[];
}): NotificationRecord[] {
  const now = new Date().toISOString();
  const byDedup = new Map(params.existingNotifications.map((n) => [n.dedupKey, n]));
  const channel = params.preferences.smtpDigestEnabled
    ? "in_app_and_smtp_queued"
    : "in_app";

  const candidates: Array<Omit<NotificationRecord, "id" | "readAt" | "acknowledgedAt" | "acknowledgedBy" | "createdAt">> = [];

  for (const defect of params.defects) {
    if (defect.status === "open" && defect.severity === "critical") {
      candidates.push({
        businessId: params.businessId,
        type: "vehicle_stop_use",
        severity: "critical",
        title: "STOP DO NOT USE — Critical vehicle defect open",
        body: `${defect.summary} (reported ${formatDateSA(defect.reportedDate)} by ${defect.reportedByName}).`,
        dedupKey: `defect:${defect.id}`,
        linkTo: "/vehicles",
        deliveryChannel: channel,
      });
    }
  }

  if (
    params.preferences.cashShortfallAlertEnabled &&
    params.forecast &&
    params.forecast.peakShortfallCents > 0 &&
    params.forecast.earliestNegativeWeekDate
  ) {
    candidates.push({
      businessId: params.businessId,
      type: "cash_shortfall",
      severity: "critical",
      title: `Projected cash shortfall of ${formatZarCents(params.forecast.peakShortfallCents)}`,
      body: `Earliest negative week starts ${formatDateSA(params.forecast.earliestNegativeWeekDate)} before the next expected customer receipt.`,
      dedupKey: `shortfall:${params.forecast.earliestNegativeWeekDate}:${params.forecast.peakShortfallCents}`,
      linkTo: "/cash-flow",
      deliveryChannel: channel,
    });
  }

  for (const report of params.reports) {
    if (report.status === "returned") {
      candidates.push({
        businessId: params.businessId,
        type: "weekly_report_returned",
        severity: "warning",
        title: `Weekly report returned (${formatDateSA(report.weekStart)})`,
        body: report.latestComment ?? "Admin returned this report for correction.",
        dedupKey: `report-returned:${report.id}:r${report.currentRevision}`,
        linkTo: "/reports",
        deliveryChannel: channel,
      });
    }
  }

  if (params.preferences.missingReceiptAlertEnabled) {
    const missing = params.expenses.filter((e) => e.receiptAttachment === null);
    if (missing.length > 0) {
      candidates.push({
        businessId: params.businessId,
        type: "expense_missing_receipt",
        severity: "warning",
        title: `${missing.length} expense(s) missing receipt photo`,
        body: "Review missing-receipt reasons in Expenses before finalising the week.",
        dedupKey: `missing-receipts:${missing.map((m) => m.id).sort().join(",")}`,
        linkTo: "/expenses",
        deliveryChannel: channel,
      });
    }
  }

  for (const exp of params.expenses) {
    if (exp.amountCents >= params.preferences.largeExpenseThresholdCents) {
      candidates.push({
        businessId: params.businessId,
        type: "expense_large",
        severity: "info",
        title: `Large expense recorded: ${formatZarCents(exp.amountCents)}`,
        body: `${exp.description} (${formatDateSA(exp.expenseDate)}).`,
        dedupKey: `large-expense:${exp.id}`,
        linkTo: "/expenses",
        deliveryChannel: channel,
      });
    }
  }

  if (params.loanBalanceCents > 0) {
    candidates.push({
      businessId: params.businessId,
      type: "loan_repayment_due",
      severity: "info",
      title: `Outstanding loan balance: ${formatZarCents(params.loanBalanceCents)}`,
      body: "Track progress receipts and scheduled repayments on the Loans page (0% interest).",
      dedupKey: `loan-balance:${params.loanBalanceCents}`,
      linkTo: "/loans",
      deliveryChannel: channel,
    });
  }

  const merged: NotificationRecord[] = [...params.existingNotifications];
  for (const cand of candidates) {
    if (!byDedup.has(cand.dedupKey)) {
      const created: NotificationRecord = {
        ...cand,
        id: `notif-${cand.dedupKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48)}`,
        readAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        createdAt: now,
      };
      byDedup.set(cand.dedupKey, created);
      merged.unshift(created);
    }
  }

  return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Neutralize spreadsheet formula injection (spec Section 18).
 * Any cell starting with =, +, -, @, tab, or CR is prefixed with a single quote.
 */
export function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface ExportMetadata {
  title: string;
  businessName: string;
  dateRange: string;
  revision: string;
  status: string;
  sourceIds: string[];
  generatedAt: string;
}

export function buildSafeCsv(
  metadata: ExportMetadata,
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  const metaLines = [
    ["Report", metadata.title],
    ["Business", metadata.businessName],
    ["Date range", metadata.dateRange],
    ["Revision", metadata.revision],
    ["Status", metadata.status],
    ["Generated at", metadata.generatedAt],
    ["Source IDs", metadata.sourceIds.join("; ") || "None"],
    [],
  ];
  const allRows = [...metaLines, headers, ...rows];
  return "\uFEFF" + allRows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build an Excel-compatible SpreadsheetML (.xls) XML file with formula-injection protection.
 */
export function buildSpreadsheetXml(
  metadata: ExportMetadata,
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  const safeCell = (v: string | number | boolean | null | undefined): string => {
    const str = v === null || v === undefined ? "" : String(v);
    const neutralized = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
    return `<Cell><Data ss:Type="String">${escapeXml(neutralized)}</Data></Cell>`;
  };

  const metaRows = [
    ["Report", metadata.title],
    ["Business", metadata.businessName],
    ["Date range", metadata.dateRange],
    ["Revision", metadata.revision],
    ["Status", metadata.status],
    ["Generated at", metadata.generatedAt],
    ["Source IDs", metadata.sourceIds.join("; ") || "None"],
    [],
  ];

  const xmlRows = [...metaRows, headers, ...rows]
    .map((r) => `<Row>${r.map(safeCell).join("")}</Row>`)
    .join("\n");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="WorkTrack">
  <Table>
${xmlRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

/**
 * Build a clean printable HTML document for Save-as-PDF export with source IDs & status.
 */
export function buildPrintableReportHtml(
  metadata: ExportMetadata,
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  const headerHtml = headers.map((h) => `<th>${escapeXml(h)}</th>`).join("");
  const bodyHtml = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c) => `<td>${escapeXml(c === null || c === undefined ? "" : String(c))}</td>`)
          .join("")}</tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeXml(metadata.title)} — WorkTrack</title>
<style>
  body { font-family: system-ui, sans-serif; color: #111827; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .meta { font-size: 12px; color: #4b5563; margin-bottom: 16px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; }
</style>
</head>
<body>
  <h1>${escapeXml(metadata.title)}</h1>
  <div class="meta">
    <div><strong>Business:</strong> ${escapeXml(metadata.businessName)}</div>
    <div><strong>Date range:</strong> ${escapeXml(metadata.dateRange)} · <strong>Revision:</strong> ${escapeXml(metadata.revision)} · <strong>Status:</strong> ${escapeXml(metadata.status)}</div>
    <div><strong>Generated:</strong> ${escapeXml(metadata.generatedAt)} · <strong>Source IDs:</strong> ${escapeXml(metadata.sourceIds.join(", ") || "None")}</div>
  </div>
  <table>
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</body>
</html>`;
}