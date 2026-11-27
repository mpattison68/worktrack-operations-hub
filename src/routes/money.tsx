import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs, listWorkforceBundle } from "@/lib/data/repository";
import { listPayrollRuns } from "@/lib/data/increment-c-repository";
import { listFinanceBundle } from "@/lib/data/increment-d-repository";
import { can } from "@/lib/permissions";
import { WagePaymentsPanel } from "@/components/WagePaymentsPanel";
import { ExpensesPanel } from "@/components/ExpensesPanel";
import { CashFlowPanel } from "@/components/CashFlowPanel";
import { LoansPanel } from "@/components/LoansPanel";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/money")({
  head: () => ({
    meta: [
      { title: "Money — WorkTrack" },
      { name: "description", content: "Wage payments, expenses, cash ledger, transfers, and loans." },
      { property: "og:title", content: "Money — WorkTrack" },
      { property: "og:description", content: "Wage payments, expenses, cash ledger, transfers, and loans." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MoneyPage,
});

function MoneyPage() {
  const { session } = useWorkTrackAuth();
  const canViewFinance = can(session?.role, "loans.view") || can(session?.role, "payroll.view");

  const financeQuery = useQuery({
    queryKey: ["finance", session?.businessId, session?.userId],
    queryFn: () => listFinanceBundle(session!),
    enabled: Boolean(session),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });
  const workforceQuery = useQuery({
    queryKey: ["workforce", session?.businessId, session?.userId],
    queryFn: () => listWorkforceBundle(session!),
    enabled: Boolean(session && canViewFinance),
  });
  const payrollRunsQuery = useQuery({
    queryKey: ["payroll-runs", session?.businessId, "all"],
    queryFn: () => listPayrollRuns(session!),
    enabled: Boolean(session && canViewFinance),
  });

  if (!session) return null;
  const finance = financeQuery.data;
  const jobs = jobsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{en.finance.moneyTitle}</h1>
        <p className="text-sm text-muted-foreground">{en.finance.moneySubtitle}</p>
      </div>

      {!canViewFinance && (
        <Card className="border-status-warn/40 bg-status-warn-bg">
          <CardContent className="flex items-center gap-2 p-3 text-xs text-status-warn">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>{en.finance.accessDenied} You can still capture field expenses for assigned jobs below.</span>
          </CardContent>
        </Card>
      )}

      {!finance ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading financial records...
          </CardContent>
        </Card>
      ) : canViewFinance ? (
        <Tabs defaultValue="wages" className="space-y-4">
          <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-flex">
            <TabsTrigger value="wages" className="touch-target">Wage payments</TabsTrigger>
            <TabsTrigger value="expenses" className="touch-target">Expenses</TabsTrigger>
            <TabsTrigger value="cash" className="touch-target">Cash &amp; forecast</TabsTrigger>
            <TabsTrigger value="loans" className="touch-target">Loans</TabsTrigger>
          </TabsList>
          <TabsContent value="wages">
            <WagePaymentsPanel
              session={session}
              finance={finance}
              workers={workforceQuery.data?.workers ?? []}
              jobs={jobs}
              payrollRuns={payrollRunsQuery.data ?? []}
            />
          </TabsContent>
          <TabsContent value="expenses">
            <ExpensesPanel session={session} finance={finance} jobs={jobs} />
          </TabsContent>
          <TabsContent value="cash">
            <CashFlowPanel session={session} finance={finance} jobs={jobs} />
          </TabsContent>
          <TabsContent value="loans">
            <LoansPanel session={session} finance={finance} />
          </TabsContent>
        </Tabs>
      ) : (
        <ExpensesPanel session={session} finance={finance} jobs={jobs} />
      )}
    </div>
  );
}