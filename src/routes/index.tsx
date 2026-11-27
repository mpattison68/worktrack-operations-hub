import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  Clock,
  CreditCard,
  HardHat,
  Settings,
  Users,
} from "lucide-react";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs, listWorkforceBundle } from "@/lib/data/repository";
import { can } from "@/lib/permissions";
import { formatDateSA, formatZarCents } from "@/lib/format";
import { en } from "@/i18n/en";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — WorkTrack" },
      {
        name: "description",
        content: "WorkTrack Increment A overview for road-verge clearing operations.",
      },
      { property: "og:title", content: "Overview — WorkTrack" },
      {
        property: "og:description",
        content: "WorkTrack Increment A overview for road-verge clearing operations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  const { session } = useWorkTrackAuth();

  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });

  const workforceQuery = useQuery({
    queryKey: ["workforce", session?.businessId, session?.userId],
    queryFn: () => listWorkforceBundle(session!),
    enabled: Boolean(session),
  });

  if (!session) return null;

  const jobs = jobsQuery.data ?? [];
  const workers = workforceQuery.data?.workers ?? [];
  const payRules = workforceQuery.data?.payRules ?? [];
  const activeWorkers = workers.filter((w) => w.active);
  const unconfirmedRules = payRules.filter((r) => !r.isConfirmed);
  const pendingOverrides = (workforceQuery.data?.rateOverrides ?? []).filter(
    (o) => o.status === "pending",
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {session.businessName}
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {session.role === "admin" ? en.nav.overview : en.nav.home}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as {session.fullName} ({en.roles[session.role]}). Increments A, B &amp; C are
            active.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild className="touch-target gap-2">
            <Link to="/work">
              <HardHat className="h-4 w-4" />
              {en.nav.work}
            </Link>
          </Button>
          {can(session.role, "payroll.view") && (
            <Button asChild variant="outline" className="touch-target gap-2">
              <Link to="/payroll">
                <CreditCard className="h-4 w-4" />
                {en.nav.payroll}
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" className="touch-target gap-2">
            <Link to="/jobs">
              <Briefcase className="h-4 w-4" />
              {en.nav.jobs}
            </Link>
          </Button>
          <Button asChild variant="outline" className="touch-target gap-2">
            <Link to="/workers">
              <Users className="h-4 w-4" />
              {en.nav.workers}
            </Link>
          </Button>
          {can(session.role, "business.view") && (
            <Button asChild variant="outline" className="touch-target gap-2">
              <Link to="/settings">
                <Settings className="h-4 w-4" />
                {en.nav.settings}
              </Link>
            </Button>
          )}
        </div>
      </div>

      {can(session.role, "rates.view") && unconfirmedRules.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-status-warn/40 bg-status-warn-bg p-4 text-sm text-status-warn">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">
              {unconfirmedRules.length} pay rule(s) marked unconfirmed
            </p>
            <p className="mt-0.5 text-xs">
              {en.workers.unconfirmedWarning}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Visible jobs</CardDescription>
            <CardTitle className="text-3xl tabular-money">{jobs.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {jobs.filter((j) => j.status === "active").length} active ·{" "}
            {jobs.filter((j) => j.status === "planned").length} planned
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active workers</CardDescription>
            <CardTitle className="text-3xl tabular-money">{activeWorkers.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {workers.length - activeWorkers.length} former preserved
          </CardContent>
        </Card>

        {can(session.role, "rates.view") && (
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Configured pay rules</CardDescription>
              <CardTitle className="text-3xl tabular-money">{payRules.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {unconfirmedRules.length} unconfirmed · {pendingOverrides.length} pending override(s)
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Release increment</CardDescription>
            <CardTitle className="text-3xl">C</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Increments D–F disabled until review
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Configured jobs</CardTitle>
            <CardDescription>
              {session.role === "supervisor"
                ? "Showing jobs assigned to you."
                : "Jobs within your business boundary."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{en.jobs.empty}</p>
            ) : (
              jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{job.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {job.roadOrArea} · Start {formatDateSA(job.plannedStartDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {can(session.role, "rates.view") && (
                      <span className="text-xs font-semibold tabular-money">
                        {formatZarCents(job.contractValueCents)}
                      </span>
                    )}
                    <Badge variant="outline">{job.status.replace(/_/g, " ")}</Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Staged delivery status</CardTitle>
            <CardDescription>
              Per <code>docs/specification.md</code> Section 20 — built sequentially.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              { id: "A", label: "Foundation, auth, RBAC, jobs, roles/rates/roster, migrations & VM skeleton", done: true },
              { id: "B", label: "Site assessment wizard, routes, strips, sizing & scope revisions", done: true },
              { id: "C", label: "Daily progress, interruptions, weekly attendance & payroll", done: true },
              { id: "D", label: "Wage payments, expenses, balanced cash ledger, loans & forecast", done: false },
              { id: "E", label: "Weekly reports, dashboard drilldowns, exports & truck checks", done: false },
              { id: "F", label: "Offline queue/sync, security audit, Android trial & VM rollout", done: false },
            ].map((inc) => (
              <div key={inc.id} className="flex items-start gap-2.5">
                {inc.done ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-ok" />
                ) : (
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span>
                  <strong>Increment {inc.id}:</strong>{" "}
                  <span className={inc.done ? "text-foreground" : "text-muted-foreground"}>
                    {inc.label}
                  </span>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
