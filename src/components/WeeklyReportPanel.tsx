import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  History,
  Lock,
  RotateCcw,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs, listWorkforceBundle } from "@/lib/data/repository";
import {
  getDefaultScopeForJob,
  listAttendanceForWeek,
  listJobProgressBundle,
  listPayrollRuns,
} from "@/lib/data/increment-c-repository";
import { listFinanceBundle } from "@/lib/data/increment-d-repository";
import {
  approveWeeklyReport,
  listIncrementEBundle,
  returnWeeklyReport,
  startWeeklyReportAmendment,
  submitWeeklyReport,
} from "@/lib/data/increment-e-repository";
import { calculateJobProgress } from "@/lib/domain/progress-calc";
import { assembleWeeklyReportSnapshot } from "@/lib/domain/increment-e-calc";
import { can } from "@/lib/permissions";
import {
  formatDateSA,
  formatZarCents,
  getMonSunWeekRange,
  todaySAST,
} from "@/lib/format";
import { en } from "@/i18n/en";
import { ExportsPanel } from "@/components/ExportsPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function WeeklyReportPanel() {
  const { session } = useWorkTrackAuth();
  const qc = useQueryClient();
  const canFinancial = can(session?.role, "payroll.view");

  const [selectedJobId, setSelectedJobId] = React.useState<string>("");
  const [weekAnchorDate, setWeekAnchorDate] = React.useState<string>(() => todaySAST());
  const weekRange = React.useMemo(() => getMonSunWeekRange(weekAnchorDate), [weekAnchorDate]);

  const [missingAck, setMissingAck] = React.useState(false);
  const [submitNote, setSubmitNote] = React.useState("");
  const [returnOpen, setReturnOpen] = React.useState(false);
  const [returnComment, setReturnComment] = React.useState("");
  const [amendOpen, setAmendOpen] = React.useState(false);
  const [amendReason, setAmendReason] = React.useState("");

  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });
  const jobs = jobsQuery.data ?? [];

  React.useEffect(() => {
    if (!selectedJobId && jobs.length > 0) {
      setSelectedJobId(jobs[0]!.id);
    }
  }, [jobs, selectedJobId]);

  const activeJob = jobs.find((j) => j.id === selectedJobId) ?? null;

  const workforceQuery = useQuery({
    queryKey: ["workforce", session?.businessId, session?.userId],
    queryFn: () => listWorkforceBundle(session!),
    enabled: Boolean(session),
  });
  const progressQuery = useQuery({
    queryKey: ["progress", session?.businessId, selectedJobId],
    queryFn: () => listJobProgressBundle(session!, selectedJobId),
    enabled: Boolean(session && selectedJobId),
  });
  const attendanceQuery = useQuery({
    queryKey: ["attendance", session?.businessId, selectedJobId, weekRange.start],
    queryFn: () => listAttendanceForWeek(session!, selectedJobId, weekRange.start),
    enabled: Boolean(session && selectedJobId),
  });
  const payrollQuery = useQuery({
    queryKey: ["payroll", session?.businessId, selectedJobId],
    queryFn: () => listPayrollRuns(session!, selectedJobId),
    enabled: Boolean(session && selectedJobId && canFinancial),
  });
  const financeQuery = useQuery({
    queryKey: ["finance", session?.businessId, session?.userId],
    queryFn: () => listFinanceBundle(session!),
    enabled: Boolean(session && canFinancial),
  });
  const incEQuery = useQuery({
    queryKey: ["increment-e", session?.businessId, session?.userId],
    queryFn: () => listIncrementEBundle(session!),
    enabled: Boolean(session),
  });

  const existingReport = React.useMemo(
    () =>
      (incEQuery.data?.reports ?? []).find(
        (r) => r.jobId === selectedJobId && r.weekStart === weekRange.start,
      ) ?? null,
    [incEQuery.data?.reports, selectedJobId, weekRange.start],
  );

  const liveSnapshot = React.useMemo(() => {
    if (!activeJob) return null;
    const scope = getDefaultScopeForJob(activeJob.id);
    const progressEntries = progressQuery.data?.entries ?? [];
    const calc = calculateJobProgress(scope, progressEntries);
    const finance = financeQuery.data ?? {
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
    };

    return assembleWeeklyReportSnapshot({
      job: activeJob,
      weekStart: weekRange.start,
      weekEnd: weekRange.end,
      progressEntries,
      cumulativeCompletedPercent: calc.physicalPercent,
      effortWeightedPercent: calc.effortWeightedPercent,
      interruptions: progressQuery.data?.interruptions ?? [],
      teamDays: attendanceQuery.data?.teamDays ?? [],
      attendanceEntries: attendanceQuery.data?.attendanceEntries ?? [],
      payrollRuns: payrollQuery.data ?? [],
      wagePayments: finance.wagePayments,
      workers: workforceQuery.data?.workers ?? [],
      expenses: finance.expenses,
      financeBundle: finance,
      checks: incEQuery.data?.checks ?? [],
      defects: incEQuery.data?.defects ?? [],
    });
  }, [
    activeJob,
    weekRange,
    progressQuery.data,
    attendanceQuery.data,
    payrollQuery.data,
    financeQuery.data,
    workforceQuery.data,
    incEQuery.data,
  ]);

  const displayedSnapshot =
    existingReport?.status === "approved" && existingReport.lockedSnapshot
      ? existingReport.lockedSnapshot
      : liveSnapshot;

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!session || !liveSnapshot) throw new Error("No report data available.");
      return submitWeeklyReport(session, {
        snapshot: liveSnapshot,
        missingEvidenceAcknowledged: missingAck,
        comment: submitNote,
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success(`Weekly report submitted (Rev ${r.currentRevision}).`);
      setSubmitNote("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const returnMutation = useMutation({
    mutationFn: async () => {
      if (!session || !existingReport) throw new Error("No report to return.");
      return returnWeeklyReport(session, existingReport.id, returnComment);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success("Weekly report returned to Owner with comments.");
      setReturnOpen(false);
      setReturnComment("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!session || !existingReport) throw new Error("No report to approve.");
      return approveWeeklyReport(session, existingReport.id, "Approved & snapshot locked.");
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success(`Weekly report Rev ${r.currentRevision} approved and locked.`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const amendMutation = useMutation({
    mutationFn: async () => {
      if (!session || !existingReport) throw new Error("No report to amend.");
      return startWeeklyReportAmendment(session, existingReport.id, amendReason);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success("Amendment draft opened — prior locked revision preserved in history.");
      setAmendOpen(false);
      setAmendReason("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!session) return null;

  const status = existingReport?.status ?? "draft";
  const needsMissingAck =
    (liveSnapshot?.missingReceiptsCount ?? 0) > 0 || (liveSnapshot?.truckChecksCount ?? 0) === 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{en.reports.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{en.reports.subtitle}</p>
      </div>

      {!canFinancial && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{en.reports.supervisorNotice}</p>
        </div>
      )}

      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rep-job">Job</Label>
            <select
              id="rep-job"
              value={selectedJobId}
              onChange={(e) => setSelectedJobId(e.target.value)}
              className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rep-week">
              Week (Mon–Sun SAST: {formatDateSA(weekRange.start)} – {formatDateSA(weekRange.end)})
            </Label>
            <Input
              id="rep-week"
              type="date"
              value={weekAnchorDate}
              onChange={(e) => setWeekAnchorDate(e.target.value)}
              className="h-11"
            />
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="weekly">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="weekly" className="min-h-11">
            {en.reports.tabWeekly}
          </TabsTrigger>
          <TabsTrigger value="exports" className="min-h-11">
            {en.reports.tabExports}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="weekly" className="mt-4 space-y-4">
          {displayedSnapshot && (
            <>
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <FileCheck2 className="h-5 w-5 text-muted-foreground" />
                        {displayedSnapshot.jobName}
                      </CardTitle>
                      <CardDescription>
                        Week {formatDateSA(displayedSnapshot.weekStart)} –{" "}
                        {formatDateSA(displayedSnapshot.weekEnd)}
                        {existingReport ? ` · Rev ${existingReport.currentRevision}` : " · Live draft"}
                      </CardDescription>
                    </div>
                    <Badge
                      variant={
                        status === "approved"
                          ? "default"
                          : status === "returned"
                            ? "destructive"
                            : "outline"
                      }
                      className="uppercase"
                    >
                      {status === "approved" ? "Approved & locked" : status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  {existingReport?.latestComment && (
                    <div
                      className={`rounded-md border p-3 text-sm ${
                        status === "returned"
                          ? "border-status-danger/40 bg-status-danger-bg text-status-danger"
                          : "border-border bg-muted/40"
                      }`}
                    >
                      <strong>Latest review note:</strong> {existingReport.latestComment}
                    </div>
                  )}

                  {/* Operational summary */}
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Operational summary (Actual)
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-md border border-border p-3">
                        <p className="text-xs text-muted-foreground">Weekly cleared</p>
                        <p className="text-xl font-bold tabular-money">
                          {displayedSnapshot.weeklyClearedDistanceM.toLocaleString()} m
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {displayedSnapshot.progressEntriesCount} entries
                        </p>
                      </div>
                      <div className="rounded-md border border-border p-3">
                        <p className="text-xs text-muted-foreground">Cumulative / Effort %</p>
                        <p className="text-xl font-bold tabular-money">
                          {displayedSnapshot.cumulativeCompletedPercent}% /{" "}
                          {displayedSnapshot.effortWeightedPercent}%
                        </p>
                        <p className="text-xs text-muted-foreground">Physical vs effort-weighted</p>
                      </div>
                      <div className="rounded-md border border-border p-3">
                        <p className="text-xs text-muted-foreground">Worker-days &amp; downtime</p>
                        <p className="text-xl font-bold tabular-money">
                          {displayedSnapshot.productiveWorkerDays} d
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {displayedSnapshot.interruptionHoursLost} hrs lost (
                          {displayedSnapshot.interruptionsCount} events)
                        </p>
                      </div>
                      <div className="rounded-md border border-border p-3">
                        <p className="text-xs text-muted-foreground">Daily truck checks</p>
                        <p className="text-xl font-bold tabular-money">
                          {displayedSnapshot.truckChecksCount}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {displayedSnapshot.openCriticalDefectsCount} open critical defect(s)
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Financial summary (Admin & Owner only) */}
                  {canFinancial && (
                    <div>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Payroll &amp; financial summary (Restricted)
                      </h3>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="rounded-md border border-border p-3">
                          <p className="text-xs text-muted-foreground">Wages earned (single run)</p>
                          <p className="text-lg font-bold tabular-money">
                            {formatZarCents(displayedSnapshot.wagesEarnedCents)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Status: {displayedSnapshot.payrollRunStatus ?? "No payroll run"}
                          </p>
                        </div>
                        <div className="rounded-md border border-border p-3">
                          <p className="text-xs text-muted-foreground">Wages paid / Prior arrears</p>
                          <p className="text-lg font-bold tabular-money">
                            {formatZarCents(displayedSnapshot.wagesPaidCents)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Opening arrears: {formatZarCents(displayedSnapshot.priorArrearsCents)}
                          </p>
                        </div>
                        <div className="rounded-md border border-border p-3">
                          <p className="text-xs text-muted-foreground">Expenses / Cash spent</p>
                          <p className="text-lg font-bold tabular-money">
                            {formatZarCents(displayedSnapshot.expensesIncurredCents)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Cash out: {formatZarCents(displayedSnapshot.cashSpentCents)} · Inflows:{" "}
                            {formatZarCents(displayedSnapshot.inflowsCents)}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Completeness warnings */}
                  {displayedSnapshot.completeness.warnings.length > 0 && (
                    <div className="rounded-md border border-status-warn/40 bg-status-warn-bg p-3 text-xs text-status-warn">
                      <p className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        Completeness checks
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5">
                        {displayedSnapshot.completeness.warnings.map((w, idx) => (
                          <li key={idx}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Submission & approval workflow */}
                  {status !== "approved" && can(session.role, "reports.submit") && (
                    <div className="space-y-3 border-t border-border pt-4">
                      {needsMissingAck && (
                        <label className="flex items-start gap-2.5 text-sm">
                          <Checkbox
                            checked={missingAck}
                            onCheckedChange={(v) => setMissingAck(Boolean(v))}
                            className="mt-0.5"
                          />
                          <span>{en.reports.missingEvidenceNotice}</span>
                        </label>
                      )}
                      <div className="space-y-1.5">
                        <Label htmlFor="submit-note">Submission note (optional)</Label>
                        <Input
                          id="submit-note"
                          value={submitNote}
                          onChange={(e) => setSubmitNote(e.target.value)}
                          placeholder="e.g. Friday afternoon rain stopped clearing at 14:00"
                          className="h-11"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          onClick={() => submitMutation.mutate()}
                          disabled={submitMutation.isPending}
                          className="touch-target gap-2"
                        >
                          <Send className="h-4 w-4" />
                          {status === "returned"
                            ? "Resubmit amended weekly report"
                            : en.reports.submitButton}
                        </Button>

                        {status === "submitted" && can(session.role, "reports.approve") && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => setReturnOpen(true)}
                              className="touch-target gap-2"
                            >
                              <RotateCcw className="h-4 w-4" />
                              {en.reports.returnButton}
                            </Button>
                            <Button
                              type="button"
                              onClick={() => approveMutation.mutate()}
                              disabled={approveMutation.isPending}
                              className="touch-target gap-2 bg-status-ok text-white hover:bg-status-ok/90"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              {en.reports.approveButton}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {status === "approved" && can(session.role, "reports.approve") && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                      <p className="text-xs text-muted-foreground">
                        Snapshot locked on {formatDateSA(existingReport?.reviewedAt)} by{" "}
                        {existingReport?.reviewedBy}. Underlying values cannot be silently edited.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="touch-target gap-2"
                        onClick={() => setAmendOpen(true)}
                      >
                        <RotateCcw className="h-4 w-4" />
                        {en.reports.amendButton}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Revision history */}
              {existingReport && existingReport.revisions.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <History className="h-4 w-4 text-muted-foreground" />
                      Revision &amp; approval history
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {existingReport.revisions.map((rev) => (
                      <div
                        key={rev.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-xs"
                      >
                        <div>
                          <p className="font-semibold">
                            Rev {rev.revisionNumber} — {rev.status.toUpperCase()} by {rev.actorName}
                          </p>
                          {rev.comment && (
                            <p className="mt-0.5 text-muted-foreground">{rev.comment}</p>
                          )}
                        </div>
                        <div className="text-right text-muted-foreground">
                          <p>{formatDateSA(rev.createdAt)}</p>
                          {canFinancial && (
                            <p className="tabular-money">
                              Wages: {formatZarCents(rev.snapshot.wagesEarnedCents)}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="exports" className="mt-4">
          <ExportsPanel
            session={session}
            jobs={jobs}
            selectedJobId={selectedJobId}
            weekStart={weekRange.start}
            weekEnd={weekRange.end}
            reports={incEQuery.data?.reports ?? []}
            progressEntries={progressQuery.data?.entries ?? []}
            interruptions={progressQuery.data?.interruptions ?? []}
            payrollRuns={payrollQuery.data ?? []}
            workers={workforceQuery.data?.workers ?? []}
            financeBundle={financeQuery.data ?? null}
            assets={incEQuery.data?.assets ?? []}
            checks={incEQuery.data?.checks ?? []}
          />
        </TabsContent>
      </Tabs>

      {/* Return dialog */}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return weekly report for correction</DialogTitle>
            <DialogDescription>
              Specify what the Owner needs to fix or attach before resubmitting.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={returnComment}
            onChange={(e) => setReturnComment(e.target.value)}
            placeholder="e.g. Please attach the missing fuel receipt reason and confirm Friday attendance."
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnOpen(false)}>
              {en.common.cancel}
            </Button>
            <Button onClick={() => returnMutation.mutate()} disabled={returnMutation.isPending}>
              Return report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Amendment dialog */}
      <Dialog open={amendOpen} onOpenChange={setAmendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start documented amendment revision</DialogTitle>
            <DialogDescription>
              The approved revision stays preserved in history. State why a new revision is needed.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={amendReason}
            onChange={(e) => setAmendReason(e.target.value)}
            placeholder="e.g. Late supplier invoice received for Friday repair."
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAmendOpen(false)}>
              {en.common.cancel}
            </Button>
            <Button onClick={() => amendMutation.mutate()} disabled={amendMutation.isPending}>
              Open amendment draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}