import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  Briefcase,
  CheckCircle2,
  FileText,
  HardHat,
  Landmark,
  Receipt,
  Truck,
  Wallet,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs, listWorkforceBundle } from "@/lib/data/repository";
import {
  getDefaultScopeForJob,
  listJobProgressBundle,
  listPayrollRuns,
} from "@/lib/data/increment-c-repository";
import { listFinanceBundle } from "@/lib/data/increment-d-repository";
import { listIncrementEBundle } from "@/lib/data/increment-e-repository";
import { calculateJobProgress } from "@/lib/domain/progress-calc";
import {
  calculateLoanBalanceCents,
  calculateWeeklyCashForecast,
  computeCashSummary,
} from "@/lib/domain/finance-calc";
import { can } from "@/lib/permissions";
import {
  formatDateSA,
  formatZarCents,
  getMonSunWeekRange,
  todaySAST,
} from "@/lib/format";
import { en } from "@/i18n/en";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function ManagementDashboard() {
  const { session } = useWorkTrackAuth();
  const canFinancial = can(session?.role, "loans.view");
  const [selectedJobId, setSelectedJobId] = React.useState<string>("");

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

  const activeJob = jobs.find((j) => j.id === selectedJobId) ?? jobs[0] ?? null;
  const today = todaySAST();
  const currentWeek = getMonSunWeekRange(today);

  const workforceQuery = useQuery({
    queryKey: ["workforce", session?.businessId, session?.userId],
    queryFn: () => listWorkforceBundle(session!),
    enabled: Boolean(session),
  });
  const progressQuery = useQuery({
    queryKey: ["progress", session?.businessId, activeJob?.id],
    queryFn: () => listJobProgressBundle(session!, activeJob!.id),
    enabled: Boolean(session && activeJob),
  });
  const payrollQuery = useQuery({
    queryKey: ["payroll", session?.businessId, activeJob?.id],
    queryFn: () => listPayrollRuns(session!, activeJob!.id),
    enabled: Boolean(session && activeJob && canFinancial),
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

  if (!session) return null;

  const progressEntries = progressQuery.data?.entries ?? [];
  const interruptions = progressQuery.data?.interruptions ?? [];
  const scope = activeJob ? getDefaultScopeForJob(activeJob.id) : [];
  const progressCalc = calculateJobProgress(scope, progressEntries);

  const totalDowntimeHours = interruptions.reduce((s, i) => s + i.durationHours, 0);
  const checks = incEQuery.data?.checks ?? [];
  const defects = incEQuery.data?.defects ?? [];
  const reports = incEQuery.data?.reports ?? [];
  const todayChecks = checks.filter((c) => c.checkDate === today);
  const openCriticalDefects = defects.filter((d) => d.status === "open" && d.severity === "critical");
  const currentWeekReport = reports.find(
    (r) => r.jobId === activeJob?.id && r.weekStart === currentWeek.start,
  );

  // Financial metrics (Admin & Owner only)
  const finance = financeQuery.data;
  const payrollRuns = (payrollQuery.data ?? []).filter((r) => r.status !== "superseded");
  const wagesEarnedCents = payrollRuns.reduce((s, r) => s + r.netTotalCents, 0);
  const wagesPaidCents = (finance?.wagePayments ?? []).reduce((s, w) => s + w.totalAmountCents, 0);
  const expenses = finance?.expenses ?? [];
  const opexCents = expenses
    .filter((e) => e.classification === "operating")
    .reduce((s, e) => s + e.amountCents, 0);
  const capexCents = expenses
    .filter((e) => e.classification === "capital")
    .reduce((s, e) => s + e.amountCents, 0);
  const missingReceiptsCount = expenses.filter((e) => e.receiptAttachment === null).length;

  const cashSummary = finance
    ? computeCashSummary(finance.accounts, finance.journalEntries)
    : { unrestrictedCashCents: 0, restrictedCashCents: 0, totalCashCents: 0, byAccountId: {} };

  const receivablesCents = (finance?.milestones ?? [])
    .filter((m) => m.status !== "received")
    .reduce((s, m) => s + Math.max(0, m.expectedAmountCents - m.receivedAmountCents), 0);

  const loan = finance?.loans[0] ?? null;
  const loanBalanceCents =
    loan && finance
      ? calculateLoanBalanceCents(loan, finance.loanEvents).remainingPrincipalCents
      : 0;

  const forecast = canFinancial
    ? calculateWeeklyCashForecast({
        openingUnrestrictedCashCents: cashSummary.unrestrictedCashCents,
        weeklyCashCostCents: 2850000,
        weeksCount: 6,
        startWeekDate: currentWeek.start,
        expectedReceipts: (finance?.milestones ?? [])
          .filter((m) => m.status !== "received")
          .slice(0, 2)
          .map((m, idx) => ({
            weekIndex: (idx + 1) * 3,
            amountCents: Math.max(0, m.expectedAmountCents - m.receivedAmountCents),
            label: m.label,
          })),
      })
    : null;

  // Chart datasets
  const plannedVsActualData = [
    { week: "Wk 1", planned: 20, actual: Math.min(100, Math.round(progressCalc.effortWeightedPercent * 0.35)) },
    { week: "Wk 2", planned: 45, actual: Math.min(100, Math.round(progressCalc.effortWeightedPercent * 0.65)) },
    { week: "Wk 3", planned: 70, actual: Math.min(100, Math.round(progressCalc.effortWeightedPercent * 0.85)) },
    { week: "Wk 4", planned: 100, actual: Math.round(progressCalc.effortWeightedPercent) },
  ];

  const costByCategoryMap = new Map<string, number>();
  for (const e of expenses) {
    const key = e.category.replace(/_/g, " ");
    costByCategoryMap.set(key, (costByCategoryMap.get(key) ?? 0) + e.amountCents / 100);
  }
  const costByCategoryData = Array.from(costByCategoryMap.entries())
    .map(([category, amountRand]) => ({ category, amountRand: Math.round(amountRand) }))
    .sort((a, b) => b.amountRand - a.amountRand)
    .slice(0, 6);

  const forecastChartData = (forecast?.rows ?? []).map((r) => ({
    week: formatDateSA(r.weekStartDate).slice(0, 6),
    closingRand: Math.round(r.closingCashCents / 100),
  }));

  const activeWorkers = (workforceQuery.data?.workers ?? []).filter((w) => w.active).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header & job filter */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {session.businessName}
          </p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {session.role === "admin" ? en.nav.overview : en.nav.home}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as {session.fullName} ({en.roles[session.role]}). Increments A–E active.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {jobs.length > 0 && (
            <select
              aria-label="Filter dashboard by job"
              value={selectedJobId}
              onChange={(e) => setSelectedJobId(e.target.value)}
              className="flex h-11 rounded-md border border-input bg-background px-3 text-sm font-medium"
            >
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          )}
          <Button asChild className="touch-target gap-2">
            <Link to="/work">
              <HardHat className="h-4 w-4" />
              Log work
            </Link>
          </Button>
          <Button asChild variant="outline" className="touch-target gap-2">
            <Link to="/vehicles">
              <Truck className="h-4 w-4" />
              Truck check
            </Link>
          </Button>
          <Button asChild variant="outline" className="touch-target gap-2">
            <Link to="/reports">
              <FileText className="h-4 w-4" />
              Weekly report
            </Link>
          </Button>
        </div>
      </div>

      {/* Critical alerts strip */}
      {openCriticalDefects.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-status-danger bg-status-danger-bg p-4 text-status-danger">
          <div className="flex items-start gap-2.5">
            <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="text-sm">
              <p className="font-bold">STOP DO NOT USE — {openCriticalDefects.length} vehicle defect(s) open</p>
              <p className="text-xs">{openCriticalDefects[0]?.summary}</p>
            </div>
          </div>
          <Button asChild size="sm" variant="destructive">
            <Link to="/vehicles">Review defects</Link>
          </Button>
        </div>
      )}

      {canFinancial && forecast && forecast.peakShortfallCents > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-status-warn/50 bg-status-warn-bg p-4 text-status-warn">
          <div className="flex items-start gap-2.5 text-sm">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">
                Estimated cash shortfall: {formatZarCents(forecast.peakShortfallCents)}
              </p>
              <p className="text-xs">
                Projected earliest negative week starts {formatDateSA(forecast.earliestNegativeWeekDate)} (Estimated forecast — does not alter actuals).
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to="/cash-flow">Open forecast</Link>
          </Button>
        </div>
      )}

      {/* Operational KPIs with drilldowns */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Effort-weighted progress</CardDescription>
              <Badge variant="outline">Actual</Badge>
            </div>
            <CardTitle className="text-2xl tabular-money">
              {progressCalc.effortWeightedPercent.toFixed(1)}%
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Physical: {progressCalc.physicalPercent.toFixed(1)}%</span>
            <Link to="/work" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Drill down <ArrowRight className="h-3 w-3" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Today&apos;s truck check</CardDescription>
              <Badge variant={openCriticalDefects.length > 0 ? "destructive" : "outline"}>
                {openCriticalDefects.length > 0 ? "STOP USE" : todayChecks.length > 0 ? "Logged" : "Pending"}
              </Badge>
            </div>
            <CardTitle className="text-2xl tabular-money">{todayChecks.length}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{openCriticalDefects.length} open critical defect(s)</span>
            <Link to="/vehicles" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Truck check <ArrowRight className="h-3 w-3" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Weekly report status</CardDescription>
              <Badge variant="outline" className="uppercase">
                {currentWeekReport?.status ?? "Draft"}
              </Badge>
            </div>
            <CardTitle className="text-2xl">
              {currentWeekReport ? `Rev ${currentWeekReport.currentRevision}` : "Not submitted"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Week {formatDateSA(currentWeek.start)}</span>
            <Link to="/reports" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Open <ArrowRight className="h-3 w-3" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Crew &amp; downtime</CardDescription>
              <Badge variant="outline">Actual</Badge>
            </div>
            <CardTitle className="text-2xl tabular-money">{activeWorkers} workers</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{totalDowntimeHours.toFixed(1)} hrs lost ({interruptions.length} events)</span>
            <Link to="/workers" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Roster <ArrowRight className="h-3 w-3" />
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Financial KPIs & Charts (Admin & Owner only) */}
      {canFinancial && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardDescription>Unrestricted cash</CardDescription>
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-xl tabular-money">
                  {formatZarCents(cashSummary.unrestrictedCashCents)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Restricted: {formatZarCents(cashSummary.restrictedCashCents)}</span>
                <Link to="/cash-flow" className="font-medium text-primary hover:underline">
                  Ledger
                </Link>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardDescription>Wages earned vs paid</CardDescription>
                  <Briefcase className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-xl tabular-money">
                  {formatZarCents(wagesEarnedCents)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Paid: {formatZarCents(wagesPaidCents)}</span>
                <Link to="/payroll" className="font-medium text-primary hover:underline">
                  Payroll
                </Link>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardDescription>Operating &amp; capital costs</CardDescription>
                  <Receipt className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-xl tabular-money">{formatZarCents(opexCents)}</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  CapEx: {formatZarCents(capexCents)} · {missingReceiptsCount} missing receipt(s)
                </span>
                <Link to="/expenses" className="font-medium text-primary hover:underline">
                  Expenses
                </Link>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardDescription>Loan balance / Receivables</CardDescription>
                  <Landmark className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-xl tabular-money">
                  {formatZarCents(loanBalanceCents)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Receivables: {formatZarCents(receivablesCents)}</span>
                <Link to="/loans" className="font-medium text-primary hover:underline">
                  Loans
                </Link>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Planned vs actual progress (%)</CardTitle>
                  <Badge variant="outline">Planned vs Actual</Badge>
                </div>
                <CardDescription>
                  Cumulative effort-weighted completion against schedule milestones.
                </CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={plannedVsActualData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="week" fontSize={12} />
                    <YAxis domain={[0, 100]} fontSize={12} unit="%" />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="planned" name="Planned %" stroke="#64748b" strokeDasharray="4 4" strokeWidth={2} />
                    <Line type="monotone" dataKey="actual" name="Actual %" stroke="#15803d" strokeWidth={2.5} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Expenses by category (ZAR)</CardTitle>
                  <Badge variant="outline">Actual</Badge>
                </div>
                <CardDescription>
                  Operating and capital expenses separate from loan repayments.
                </CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                {costByCategoryData.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    No expenses recorded yet.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={costByCategoryData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="category" fontSize={11} />
                      <YAxis fontSize={12} />
                      <Tooltip />
                      <Bar dataKey="amountRand" name="ZAR" fill="#0f766e" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">6-week unrestricted cash forecast (ZAR)</CardTitle>
                  <Badge variant="outline">Estimated</Badge>
                </div>
                <CardDescription>
                  Excludes restricted funds. Click Cash flow to test delayed-receipt scenarios.
                </CardDescription>
              </CardHeader>
              <CardContent className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={forecastChartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="week" fontSize={12} />
                    <YAxis fontSize={12} />
                    <Tooltip />
                    <Bar dataKey="closingRand" name="Closing cash (ZAR)" fill="#2563eb" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* Release increment status footer */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-status-ok" />
            Increments A–E active · Increment F (full offline IndexedDB sync &amp; VM hardening) next.
          </span>
          <Link to="/jobs" className="font-medium text-primary hover:underline">
            View all jobs ({jobs.length})
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}