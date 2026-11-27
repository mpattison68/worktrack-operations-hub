import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { addDays, format, parseISO } from "date-fns";
import {
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FileText,
  ShieldAlert,
} from "lucide-react";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs, listWorkforceBundle } from "@/lib/data/repository";
import { listAttendanceForWeek, listPayrollRuns } from "@/lib/data/increment-c-repository";
import { formatDateSA, getMonSunWeekRange, todaySAST } from "@/lib/format";
import { can } from "@/lib/permissions";
import { en } from "@/i18n/en";
import { AttendancePanel } from "@/components/AttendancePanel";
import { PayrollPanel } from "@/components/PayrollPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/payroll")({
  head: () => ({
    meta: [
      { title: "Attendance & Payroll — WorkTrack" },
      {
        name: "description",
        content: "Weekly Mon–Sun team attendance, integer-cent payroll calculations, and worker statements.",
      },
      { property: "og:title", content: "Attendance & Payroll — WorkTrack" },
      {
        property: "og:description",
        content: "Weekly Mon–Sun team attendance, integer-cent payroll calculations, and worker statements.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PayrollPage,
});

function PayrollPage() {
  const { session } = useWorkTrackAuth();
  const initialWeek = useMemo(() => getMonSunWeekRange(todaySAST()), []);
  const [weekStart, setWeekStart] = useState(initialWeek.start);
  const weekRange = useMemo(() => getMonSunWeekRange(weekStart), [weekStart]);

  const canViewPayroll = can(session?.role, "payroll.view");

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

  const jobs = jobsQuery.data ?? [];
  const [selectedJobId, setSelectedJobId] = useState("");
  const activeJobId = selectedJobId || jobs[0]?.id || "";

  const attendanceQuery = useQuery({
    queryKey: ["attendance", session?.businessId, activeJobId, weekRange.start],
    queryFn: () => listAttendanceForWeek(session!, activeJobId, weekRange.start),
    enabled: Boolean(session && activeJobId),
  });

  const payrollRunsQuery = useQuery({
    queryKey: ["payroll-runs", session?.businessId, "all"],
    queryFn: () => listPayrollRuns(session!),
    enabled: Boolean(session && canViewPayroll),
  });

  const shiftWeek = (deltaDays: number) => {
    setWeekStart(format(addDays(parseISO(weekStart), deltaDays), "yyyy-MM-dd"));
  };

  if (!session) return null;

  const workforce = workforceQuery.data;
  const att = attendanceQuery.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {canViewPayroll ? en.payroll.title : en.payroll.tabAttendance}
          </h1>
          <p className="text-sm text-muted-foreground">
            {canViewPayroll
              ? en.payroll.subtitle
              : "Record Mon–Sun team attendance and worker exceptions on your assigned job(s)."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Select job"
            value={activeJobId}
            onChange={(e) => setSelectedJobId(e.target.value)}
            className="h-11 rounded-md border border-input bg-background px-3 text-sm"
          >
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 rounded-md border border-border bg-card p-1">
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => shiftWeek(-7)} aria-label="Previous week">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-2 text-xs font-semibold tabular-money">
              {formatDateSA(weekRange.start)} – {formatDateSA(weekRange.end)}
            </span>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => shiftWeek(7)} aria-label="Next week">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {!canViewPayroll && (
        <Card className="border-status-warn/40 bg-status-warn-bg">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-status-warn">
              <ShieldAlert className="h-5 w-5" />
              Payroll &amp; worker statements restricted
            </CardTitle>
            <CardDescription className="text-status-warn">
              {en.payroll.accessDenied}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Tabs defaultValue="attendance" className="space-y-4">
        <TabsList className={`grid w-full max-w-xl ${canViewPayroll ? "grid-cols-3" : "grid-cols-1"}`}>
          <TabsTrigger value="attendance" className="touch-target gap-2">
            <CalendarCheck className="h-4 w-4" />
            {en.payroll.tabAttendance}
          </TabsTrigger>
          {canViewPayroll && (
            <TabsTrigger value="payroll" className="touch-target gap-2">
              <CreditCard className="h-4 w-4" />
              {en.payroll.tabPayroll}
            </TabsTrigger>
          )}
          {canViewPayroll && (
            <TabsTrigger value="statements" className="touch-target gap-2">
              <FileText className="h-4 w-4" />
              {en.payroll.tabStatements}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="attendance">
          {activeJobId && workforce && att ? (
            <AttendancePanel
              session={session}
              jobId={activeJobId}
              weekStartDate={weekRange.start}
              workers={workforce.workers}
              roles={workforce.roles}
              assignments={workforce.assignments}
              teamDays={att.teamDays}
              attendanceEntries={att.attendanceEntries}
              otherJobAttendance={att.otherJobAttendance}
            />
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Loading attendance data...
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {canViewPayroll && (
          <TabsContent value="payroll">
            {activeJobId && workforce && att ? (
              <PayrollPanel
                mode="calculation"
                session={session}
                jobId={activeJobId}
                weekStartDate={weekRange.start}
                workers={workforce.workers}
                roles={workforce.roles}
                assignments={workforce.assignments}
                payRules={workforce.payRules}
                rateOverrides={workforce.rateOverrides}
                teamDays={att.teamDays}
                attendanceEntries={att.attendanceEntries}
                payrollRuns={payrollRunsQuery.data ?? []}
              />
            ) : (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Loading payroll calculation...
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

        {canViewPayroll && (
          <TabsContent value="statements">
            {activeJobId && workforce && att ? (
              <PayrollPanel
                mode="statements"
                session={session}
                jobId={activeJobId}
                weekStartDate={weekRange.start}
                workers={workforce.workers}
                roles={workforce.roles}
                assignments={workforce.assignments}
                payRules={workforce.payRules}
                rateOverrides={workforce.rateOverrides}
                teamDays={att.teamDays}
                attendanceEntries={att.attendanceEntries}
                payrollRuns={payrollRunsQuery.data ?? []}
              />
            ) : (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Loading worker statements...
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}