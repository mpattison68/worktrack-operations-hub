import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Lock, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type {
  AuthSession,
  PayRule,
  Worker,
  WorkerAssignment,
  WorkerRateOverride,
  WorkerRole,
} from "@/lib/domain/types";
import type {
  AttendanceEntry,
  PayrollAdjustment,
  PayrollRun,
  TeamDay,
} from "@/lib/domain/increment-c-types";
import { buildWorkerStatement, calculatePayrollWeek } from "@/lib/domain/payroll-calc";
import { savePayrollRunDraftOrApprove } from "@/lib/data/increment-c-repository";
import { formatDateSA, formatZarCents, parseZarToCents } from "@/lib/format";
import { can } from "@/lib/permissions";
import { en } from "@/i18n/en";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PayrollPanelProps {
  mode: "calculation" | "statements";
  session: AuthSession;
  jobId: string;
  weekStartDate: string;
  workers: Worker[];
  roles: WorkerRole[];
  assignments: WorkerAssignment[];
  payRules: PayRule[];
  rateOverrides: WorkerRateOverride[];
  teamDays: TeamDay[];
  attendanceEntries: AttendanceEntry[];
  payrollRuns: PayrollRun[];
}

export function PayrollPanel({
  mode,
  session,
  jobId,
  weekStartDate,
  workers,
  roles,
  assignments,
  payRules,
  rateOverrides,
  teamDays,
  attendanceEntries,
  payrollRuns,
}: PayrollPanelProps) {
  const qc = useQueryClient();
  const roleMap = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  const [draftAdjustments, setDraftAdjustments] = useState<
    Array<{
      workerId: string;
      kind: PayrollAdjustment["kind"];
      description: string;
      amountCents: number;
    }>
  >([]);
  const [adjWorkerId, setAdjWorkerId] = useState("");
  const [adjKind, setAdjKind] = useState<PayrollAdjustment["kind"]>("allowance");
  const [adjDesc, setAdjDesc] = useState("");
  const [adjAmount, setAdjAmount] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [statementWorkerId, setStatementWorkerId] = useState("");

  const tempAdjustments: PayrollAdjustment[] = useMemo(
    () =>
      draftAdjustments.map((a, idx) => ({
        id: `tmp-${idx}`,
        businessId: session.businessId,
        payrollRunId: "preview",
        workerId: a.workerId,
        kind: a.kind,
        description: a.description,
        amountCents: a.amountCents,
        approvedByEmail: session.email,
        createdAt: "",
      })),
    [draftAdjustments, session.businessId, session.email],
  );

  const calc = useMemo(
    () =>
      calculatePayrollWeek({
        weekStartDate,
        jobId,
        workers,
        roles,
        assignments,
        payRules,
        rateOverrides,
        teamDays,
        attendanceEntries,
        adjustments: tempAdjustments,
        requireConfirmedRatesForApproval: true,
      }),
    [
      weekStartDate,
      jobId,
      workers,
      roles,
      assignments,
      payRules,
      rateOverrides,
      teamDays,
      attendanceEntries,
      tempAdjustments,
    ],
  );

  const weekRuns = useMemo(
    () => payrollRuns.filter((r) => r.jobId === jobId && r.weekStartDate === weekStartDate),
    [payrollRuns, jobId, weekStartDate],
  );
  const approvedRun = weekRuns.find((r) => r.status === "approved") ?? null;

  const saveRunMutation = useMutation({
    mutationFn: (approve: boolean) =>
      savePayrollRunDraftOrApprove(session, {
        jobId,
        weekStartDate,
        approve,
        ...(approvedRun ? { correctionReason } : {}),
        adjustments: draftAdjustments,
      }),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["payroll-runs", session.businessId, jobId] });
      qc.invalidateQueries({ queryKey: ["payroll-runs", session.businessId, "all"] });
      toast.success(
        run.status === "approved"
          ? `Payroll Rev ${run.revision} approved (${formatZarCents(run.netTotalCents)} net).`
          : `Payroll draft Rev ${run.revision} saved.`,
      );
      setDraftAdjustments([]);
      setCorrectionReason("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleAddAdjustment = () => {
    const targetWorker = adjWorkerId || calc.earnings[0]?.workerId;
    if (!targetWorker) return;
    const parsed = parseZarToCents(adjAmount);
    if (parsed === null || parsed === 0) {
      toast.error("Enter a non-zero ZAR amount.");
      return;
    }
    if (!adjDesc.trim()) {
      toast.error("Enter a description for the adjustment or deduction.");
      return;
    }
    const signed = adjKind === "statutory_deduction" ? -Math.abs(parsed) : parsed;
    setDraftAdjustments((prev) => [
      ...prev,
      { workerId: targetWorker, kind: adjKind, description: adjDesc.trim(), amountCents: signed },
    ]);
    setAdjDesc("");
    setAdjAmount("");
  };

  if (mode === "statements") {
    const activeWorker =
      workers.find((w) => w.id === statementWorkerId) ?? workers[0] ?? null;
    const statement = activeWorker
      ? buildWorkerStatement(
          activeWorker,
          roleMap.get(activeWorker.workerRoleId)?.name ?? "Role",
          payrollRuns,
        )
      : null;

    return (
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Restricted worker statement</CardTitle>
              <CardDescription>
                Shows approved net earnings, provisional drafts separately, allocated payments, and running balance (negative = advance/credit).
              </CardDescription>
            </div>
            <select
              aria-label="Select worker for statement"
              value={activeWorker?.id ?? ""}
              onChange={(e) => setStatementWorkerId(e.target.value)}
              className="h-11 rounded-md border border-input bg-background px-3 text-sm"
            >
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.fullName}
                </option>
              ))}
            </select>
          </CardHeader>
          {statement && (
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Opening balance</p>
                  <p className="text-lg font-bold tabular-money">
                    {formatZarCents(statement.openingBalanceCents)}
                  </p>
                  <Badge variant="outline" className="mt-1 text-[10px]">
                    {statement.openingBalanceVerified ? "Verified" : "Unverified"}
                  </Badge>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Approved net earned</p>
                  <p className="text-lg font-bold tabular-money">
                    {formatZarCents(statement.approvedNetTotalCents)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Provisional: {formatZarCents(statement.provisionalNetTotalCents)}
                  </p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Allocated payments</p>
                  <p className="text-lg font-bold tabular-money">
                    {formatZarCents(statement.allocatedPaymentsTotalCents)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Wage payments in Inc. D</p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Closing balance</p>
                  <p
                    className={`text-lg font-bold tabular-money ${
                      statement.closingBalanceCents < 0 ? "text-status-warn" : "text-foreground"
                    }`}
                  >
                    {formatZarCents(statement.closingBalanceCents)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {statement.closingBalanceCents < 0
                      ? "Advance / credit owed by worker"
                      : "Arrears owed to worker"}
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="py-2 pr-2">Week</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">Days / hrs</th>
                      <th className="px-2 py-2">Rate(s)</th>
                      <th className="px-2 py-2 text-right">Gross</th>
                      <th className="px-2 py-2 text-right">Adj / Ded</th>
                      <th className="px-2 py-2 text-right">Net</th>
                      <th className="px-2 py-2 text-right">Paid</th>
                      <th className="pl-2 py-2 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.rows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-6 text-center text-muted-foreground">
                          No saved or approved payroll weeks for this worker yet.
                        </td>
                      </tr>
                    ) : (
                      statement.rows.map((row) => (
                        <tr key={row.payrollRunId} className="border-b border-border/60">
                          <td className="py-2 pr-2 font-medium">
                            {formatDateSA(row.weekStartDate)} – {formatDateSA(row.weekEndDate)}
                          </td>
                          <td className="px-2 py-2">
                            <Badge variant={row.status === "approved" ? "default" : "outline"}>
                              Rev {row.revision} · {row.status}
                            </Badge>
                          </td>
                          <td className="px-2 py-2 tabular-money">
                            {row.daysWorked}d / {row.normalHours}h
                            {row.extraHours > 0 ? ` (+${row.extraHours}h)` : ""}
                          </td>
                          <td className="px-2 py-2">{row.rateSummary}</td>
                          <td className="px-2 py-2 text-right tabular-money">
                            {formatZarCents(row.grossEarnedCents)}
                          </td>
                          <td className="px-2 py-2 text-right tabular-money">
                            {formatZarCents(row.adjustmentsCents - row.deductionsCents)}
                          </td>
                          <td className="px-2 py-2 text-right font-semibold tabular-money">
                            {formatZarCents(row.netEarnedCents)}
                          </td>
                          <td className="px-2 py-2 text-right tabular-money">
                            {formatZarCents(row.allocatedPaidCents)}
                          </td>
                          <td className="pl-2 py-2 text-right font-semibold tabular-money">
                            {formatZarCents(row.runningBalanceCents)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!calc.canApprove && (
        <div className="rounded-lg border border-status-warn/40 bg-status-warn-bg p-4 text-sm text-status-warn">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Provisional preview only — approval blocked ({calc.blockingReasons.length} item(s))
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {calc.blockingReasons.slice(0, 6).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {approvedRun && (
        <div className="flex items-start gap-2 rounded-lg border border-status-ok/40 bg-status-ok-bg p-3 text-sm text-status-ok">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Approved Rev {approvedRun.revision}</strong> locked on{" "}
            {formatDateSA(approvedRun.approvedAt)} by {approvedRun.approvedByEmail} (
            {formatZarCents(approvedRun.netTotalCents)} net). Corrections require a new revision.
          </span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Gross earnings (preview)</CardDescription>
            <CardTitle className="text-2xl tabular-money">
              {formatZarCents(calc.grossTotalCents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {calc.earnings.length} assigned worker(s) · integer ZAR cents
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Adjustments / deductions</CardDescription>
            <CardTitle className="text-2xl tabular-money">
              {formatZarCents(calc.adjustmentsTotalCents - calc.deductionsTotalCents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            +{formatZarCents(calc.adjustmentsTotalCents)} / -{formatZarCents(calc.deductionsTotalCents)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Net payable</CardDescription>
            <CardTitle className="text-2xl tabular-money">
              {formatZarCents(calc.netTotalCents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {approvedRun ? `Approved Rev ${approvedRun.revision}` : "Provisional until Admin approves"}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Worker earnings breakdown</CardTitle>
          <CardDescription>
            Effective-dated rates applied per day; OT, Saturday, Sunday, and public holiday classes never double-count normal hours.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[700px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 pr-2">Worker</th>
                <th className="px-2 py-2">Days / Hrs</th>
                <th className="px-2 py-2 text-right">Normal</th>
                <th className="px-2 py-2 text-right">OT / Wknd / PH</th>
                <th className="px-2 py-2 text-right">Gross</th>
                <th className="px-2 py-2 text-right">Adj / Ded</th>
                <th className="px-2 py-2 text-right">Net</th>
                <th className="pl-2 py-2">Checks</th>
              </tr>
            </thead>
            <tbody>
              {calc.earnings.map((line) => {
                const extraPay =
                  line.weekdayOtPayCents +
                  line.saturdayPayCents +
                  line.sundayPayCents +
                  line.publicHolidayPayCents;
                return (
                  <tr key={line.workerId} className="border-b border-border/60">
                    <td className="py-2 pr-2">
                      <p className="font-semibold">{line.workerName}</p>
                      <p className="text-[11px] text-muted-foreground">{line.roleName}</p>
                    </td>
                    <td className="px-2 py-2 tabular-money">
                      {line.daysWorked}d · {line.normalHours}h
                      {line.weekdayOtHours + line.saturdayHours + line.sundayHours + line.publicHolidayHours >
                        0 && (
                        <span className="block text-[10px] text-muted-foreground">
                          OT {line.weekdayOtHours}h · Sat {line.saturdayHours}h · Sun {line.sundayHours}h · PH{" "}
                          {line.publicHolidayHours}h
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-money">
                      {formatZarCents(line.normalPayCents)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-money">
                      {formatZarCents(extraPay)}
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-money">
                      {formatZarCents(line.grossPayCents)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-money">
                      {formatZarCents(line.adjustmentsCents - line.deductionsCents)}
                    </td>
                    <td className="px-2 py-2 text-right font-bold tabular-money">
                      {formatZarCents(line.netPayCents)}
                    </td>
                    <td className="pl-2 py-2">
                      {line.hasUnknownAttendance ? (
                        <Badge variant="destructive">Unknown days</Badge>
                      ) : line.hasUnconfirmedRate ? (
                        <Badge variant="outline">Unconfirmed rate</Badge>
                      ) : line.missingRateReasons.length > 0 ? (
                        <Badge variant="destructive">Missing rate</Badge>
                      ) : (
                        <Badge variant="secondary">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Ready
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {can(session.role, "payroll.approve") && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Adjustments &amp; Admin approval</CardTitle>
            <CardDescription>
              Add approved allowances or statutory deductions, then save draft or approve this payroll week.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="adj-worker">Worker</Label>
                <select
                  id="adj-worker"
                  value={adjWorkerId || calc.earnings[0]?.workerId || ""}
                  onChange={(e) => setAdjWorkerId(e.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {calc.earnings.map((e) => (
                    <option key={e.workerId} value={e.workerId}>
                      {e.workerName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adj-kind">Type</Label>
                <select
                  id="adj-kind"
                  value={adjKind}
                  onChange={(e) => setAdjKind(e.target.value as PayrollAdjustment["kind"])}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="allowance">Allowance (+)</option>
                  <option value="bonus">Bonus (+)</option>
                  <option value="statutory_deduction">Statutory deduction (-)</option>
                  <option value="correction">Correction (+/-)</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adj-amount">Amount (ZAR)</Label>
                <Input id="adj-amount" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} placeholder="e.g. 50.00" className="h-11" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="adj-desc">Description</Label>
                <Input id="adj-desc" value={adjDesc} onChange={(e) => setAdjDesc(e.target.value)} placeholder="e.g. UIF 1%" className="h-11" />
              </div>
            </div>
            <Button type="button" variant="outline" className="touch-target gap-2" onClick={handleAddAdjustment}>
              <Plus className="h-4 w-4" />
              Add line
            </Button>

            {approvedRun && (
              <div className="space-y-1">
                <Label htmlFor="corr-reason">Correction reason (required for new revision)</Label>
                <Input
                  id="corr-reason"
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  placeholder="Explain why an approved payroll week is being revised"
                  className="h-11"
                />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="touch-target"
                disabled={saveRunMutation.isPending}
                onClick={() => saveRunMutation.mutate(false)}
              >
                Save draft
              </Button>
              <Button
                type="button"
                className="touch-target gap-2"
                disabled={!calc.canApprove || saveRunMutation.isPending}
                onClick={() => saveRunMutation.mutate(true)}
              >
                <ShieldCheck className="h-4 w-4" />
                {approvedRun ? en.payroll.createRevision : en.payroll.approvePayroll}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {weekRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Payroll revision history (this week)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {weekRuns.map((run) => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3">
                <div>
                  <span className="font-semibold">Rev {run.revision}</span> ·{" "}
                  <Badge variant={run.status === "approved" ? "default" : "outline"}>{run.status}</Badge>
                  {run.correctionReason && <span className="ml-2 text-muted-foreground">({run.correctionReason})</span>}
                </div>
                <div className="tabular-money font-semibold">
                  Gross {formatZarCents(run.grossTotalCents)} · Net {formatZarCents(run.netTotalCents)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}