import * as React from "react";
import { Download, FileSpreadsheet, FileText, Lock, Printer } from "lucide-react";
import { toast } from "sonner";
import type { AuthSession, Job, Worker } from "@/lib/domain/types";
import type {
  InterruptionEntry,
  PayrollRun,
  ProgressEntry,
} from "@/lib/domain/increment-c-types";
import type { FinanceBundle } from "@/lib/domain/increment-d-types";
import type {
  AssetCheck,
  AssetRecord,
  WeeklyReport,
} from "@/lib/domain/increment-e-types";
import {
  buildPrintableReportHtml,
  buildSafeCsv,
  buildSpreadsheetXml,
  type ExportMetadata,
} from "@/lib/domain/increment-e-calc";
import { can } from "@/lib/permissions";
import { formatDateSA, formatZarCents } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

type ExportKind =
  | "weekly_report"
  | "progress_interruptions"
  | "vehicle_checks"
  | "cash_expenses"
  | "worker_statements";

interface ExportsPanelProps {
  session: AuthSession;
  jobs: Job[];
  selectedJobId: string;
  weekStart: string;
  weekEnd: string;
  reports: WeeklyReport[];
  progressEntries: ProgressEntry[];
  interruptions: InterruptionEntry[];
  payrollRuns: PayrollRun[];
  workers: Worker[];
  financeBundle: FinanceBundle | null;
  assets: AssetRecord[];
  checks: AssetCheck[];
}

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExportsPanel(props: ExportsPanelProps) {
  const { session, jobs, selectedJobId, weekStart, weekEnd } = props;
  const canFinancial = can(session.role, "exports.financial");
  const [exportKind, setExportKind] = React.useState<ExportKind>("weekly_report");

  const buildExportPayload = (): {
    metadata: ExportMetadata;
    headers: string[];
    rows: Array<Array<string | number | boolean | null>>;
    baseFilename: string;
  } => {
    const now = new Date().toISOString();
    const job = jobs.find((j) => j.id === selectedJobId);
    const jobLabel = job ? job.name : "All visible jobs";
    const dateRange = `${formatDateSA(weekStart)} to ${formatDateSA(weekEnd)}`;

    if (exportKind === "weekly_report") {
      const report = props.reports.find(
        (r) => r.jobId === selectedJobId && r.weekStart === weekStart,
      );
      const snap =
        report?.lockedSnapshot ??
        report?.revisions[report.revisions.length - 1]?.snapshot ??
        null;
      const headers = canFinancial
        ? ["Metric", "Value", "Classification"]
        : ["Operational Metric", "Value", "Classification"];
      const rows: Array<Array<string | number>> = snap
        ? [
            ["Job", snap.jobName, "Actual"],
            ["Weekly cleared distance (m)", snap.weeklyClearedDistanceM, "Actual"],
            ["Cumulative complete (%)", `${snap.cumulativeCompletedPercent}%`, "Actual"],
            ["Effort-weighted complete (%)", `${snap.effortWeightedPercent}%`, "Actual"],
            ["Interruptions (hours lost)", snap.interruptionHoursLost, "Actual"],
            ["Productive worker-days", snap.productiveWorkerDays, "Actual"],
            ["Daily truck checks", snap.truckChecksCount, "Actual"],
            ...(canFinancial
              ? [
                  ["Wages earned", formatZarCents(snap.wagesEarnedCents), snap.payrollRunStatus ?? "Draft"],
                  ["Wages paid", formatZarCents(snap.wagesPaidCents), "Actual"],
                  ["Expenses incurred", formatZarCents(snap.expensesIncurredCents), "Actual"],
                  ["Cash spent", formatZarCents(snap.cashSpentCents), "Actual"],
                  ["Customer inflows", formatZarCents(snap.inflowsCents), "Actual"],
                  ["Missing receipts", snap.missingReceiptsCount, "Audit flag"],
                ]
              : []),
          ]
        : [["Notice", "No submitted/saved weekly report for this job and week yet.", "Draft"]];
      return {
        metadata: {
          title: `Weekly Job Report — ${jobLabel}`,
          businessName: session.businessName,
          dateRange,
          revision: report ? `Rev ${report.currentRevision}` : "Unassembled",
          status: report ? report.status.toUpperCase() : "DRAFT",
          sourceIds: report ? [report.id] : [],
          generatedAt: now,
        },
        headers,
        rows,
        baseFilename: `worktrack-weekly-report-${weekStart}`,
      };
    }

    if (exportKind === "progress_interruptions") {
      const prog = props.progressEntries.filter((p) => !selectedJobId || p.jobId === selectedJobId);
      const headers = [
        "ID",
        "Date",
        "Verge",
        "Activity",
        "Start (m)",
        "End (m)",
        "Stage",
        "Rework",
        "Verification",
        "Note",
      ];
      const rows = prog.map((p) => [
        p.id,
        formatDateSA(p.reportedDate),
        p.vergeSide,
        p.activity,
        p.startChainageMeters,
        p.endChainageMeters,
        p.stageStatus,
        p.isRework ? "Yes" : "No",
        p.verificationState,
        p.evidenceNote,
      ]);
      return {
        metadata: {
          title: `Work Progress — ${jobLabel}`,
          businessName: session.businessName,
          dateRange,
          revision: "Live",
          status: "OPERATIONAL",
          sourceIds: prog.map((p) => p.id),
          generatedAt: now,
        },
        headers,
        rows,
        baseFilename: `worktrack-progress-${weekStart}`,
      };
    }

    if (exportKind === "vehicle_checks") {
      const headers = ["Check ID", "Date", "Asset", "Odometer (km)", "Status", "Checked by", "Comment"];
      const rows = props.checks.map((c) => {
        const asset = props.assets.find((a) => a.id === c.assetId);
        return [
          c.id,
          formatDateSA(c.checkDate),
          asset?.name ?? c.assetId,
          c.odometerKm ?? "",
          c.stopUseTriggered ? "STOP DO NOT USE" : "OK",
          c.checkedByName,
          c.comment,
        ];
      });
      return {
        metadata: {
          title: "Vehicle Pre-Use Safety Checks",
          businessName: session.businessName,
          dateRange,
          revision: "Live",
          status: "SAFETY LOG",
          sourceIds: props.checks.map((c) => c.id),
          generatedAt: now,
        },
        headers,
        rows,
        baseFilename: `worktrack-vehicle-checks-${weekStart}`,
      };
    }

    if (!canFinancial) {
      throw new Error("Access denied: Supervisors cannot export financial or payroll reports.");
    }

    if (exportKind === "cash_expenses") {
      const expenses = props.financeBundle?.expenses ?? [];
      const headers = [
        "Expense ID",
        "Date",
        "Category",
        "Classification",
        "Description",
        "Amount (ZAR)",
        "Paid (ZAR)",
        "Receipt",
        "Missing Reason",
      ];
      const rows = expenses.map((e) => [
        e.id,
        formatDateSA(e.expenseDate),
        e.category,
        e.classification,
        e.description,
        formatZarCents(e.amountCents),
        formatZarCents(e.paidAmountCents),
        e.receiptAttachment ? e.receiptAttachment.fileName : "MISSING",
        e.missingReceiptReason ?? "",
      ]);
      return {
        metadata: {
          title: "Expenses & Cash Ledger Export",
          businessName: session.businessName,
          dateRange,
          revision: "Live",
          status: "FINANCIAL (RESTRICTED)",
          sourceIds: expenses.map((e) => e.id),
          generatedAt: now,
        },
        headers,
        rows,
        baseFilename: `worktrack-expenses-${weekStart}`,
      };
    }

    // Restricted worker statements
    const headers = ["Worker ID", "Worker", "Opening Balance", "Approved Weeks", "Net Earned (Latest)"];
    const rows = props.workers.map((w) => {
      const runs = props.payrollRuns.filter(
        (r) => r.status === "approved" && r.earnings.some((e) => e.workerId === w.id),
      );
      const latestNet =
        runs[0]?.earnings.find((e) => e.workerId === w.id)?.netPayCents ?? 0;
      return [
        w.id,
        w.fullName,
        formatZarCents(w.openingBalanceCents),
        runs.length,
        formatZarCents(latestNet),
      ];
    });
    return {
      metadata: {
        title: "Restricted Worker Statements Summary",
        businessName: session.businessName,
        dateRange,
        revision: "Live",
        status: "RESTRICTED — ADMIN / OWNER ONLY",
        sourceIds: props.payrollRuns.map((r) => r.id),
        generatedAt: now,
      },
      headers,
      rows,
      baseFilename: `worktrack-worker-statements-${weekStart}`,
    };
  };

  const handleDownload = (formatType: "csv" | "xls" | "pdf") => {
    try {
      const payload = buildExportPayload();
      if (formatType === "csv") {
        const csv = buildSafeCsv(payload.metadata, payload.headers, payload.rows);
        triggerDownload(csv, `${payload.baseFilename}.csv`, "text/csv;charset=utf-8");
        toast.success("Safe CSV downloaded (formula-injection protected).");
      } else if (formatType === "xls") {
        const xml = buildSpreadsheetXml(payload.metadata, payload.headers, payload.rows);
        triggerDownload(xml, `${payload.baseFilename}.xls`, "application/vnd.ms-excel");
        toast.success("Excel workbook (.xls) downloaded.");
      } else {
        const html = buildPrintableReportHtml(payload.metadata, payload.headers, payload.rows);
        const win = window.open("", "_blank", "noopener,noreferrer");
        if (win) {
          win.document.write(html);
          win.document.close();
          win.focus();
          win.print();
        } else {
          triggerDownload(html, `${payload.baseFilename}.html`, "text/html;charset=utf-8");
          toast.info("Popup blocked — downloaded printable HTML report instead.");
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">Safe open-format exports</CardTitle>
            <CardDescription>
              Every export includes source IDs, date range, timestamp, revision, status, and CSV
              formula-injection protection.
            </CardDescription>
          </div>
          {!canFinancial && (
            <Badge variant="outline" className="gap-1">
              <Lock className="h-3.5 w-3.5" />
              Operational exports only
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="export-kind">Report dataset</Label>
          <select
            id="export-kind"
            value={exportKind}
            onChange={(e) => setExportKind(e.target.value as ExportKind)}
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="weekly_report">Weekly job report (current selection)</option>
            <option value="progress_interruptions">Work progress &amp; interruptions</option>
            <option value="vehicle_checks">Vehicle pre-use safety checks</option>
            {canFinancial && (
              <option value="cash_expenses">Expenses &amp; cash ledger (Admin / Owner)</option>
            )}
            {canFinancial && (
              <option value="worker_statements">
                Worker statements summary (Restricted — Admin / Owner)
              </option>
            )}
          </select>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            className="touch-target gap-2"
            onClick={() => handleDownload("csv")}
          >
            <Download className="h-4 w-4" />
            Export safe CSV
          </Button>
          <Button
            type="button"
            variant="outline"
            className="touch-target gap-2"
            onClick={() => handleDownload("xls")}
          >
            <FileSpreadsheet className="h-4 w-4" />
            Export Excel (.xls)
          </Button>
          <Button
            type="button"
            variant="outline"
            className="touch-target gap-2"
            onClick={() => handleDownload("pdf")}
          >
            <Printer className="h-4 w-4" />
            Print / Save PDF
          </Button>
        </div>

        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <FileText className="h-4 w-4 shrink-0" />
          <span>
            Cells beginning with <code>=</code>, <code>+</code>, <code>-</code>, or <code>@</code>{" "}
            are automatically escaped to prevent spreadsheet formula injection.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}