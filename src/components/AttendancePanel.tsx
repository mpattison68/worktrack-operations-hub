import { useOfflineSync } from "@/lib/offline/sync-context";
import { enqueueOfflineMutation } from "@/lib/offline/sync-engine";
import { applyOperationalCapture } from "@/lib/offline/operational-capture";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { AlertTriangle, CheckCircle2, Copy, RotateCcw, UserCheck } from "lucide-react";
import { toast } from "sonner";
import type { AuthSession, Worker, WorkerAssignment, WorkerRole } from "@/lib/domain/types";
import {
  INTERRUPTION_REASON_LABELS,
  type AttendanceEntry,
  type DayWorkStatus,
  type InterruptionReason,
  type TeamDay,
} from "@/lib/domain/increment-c-types";
import {
  getWeekDates,
  resolveEffectiveWorkerDay,
  validateAttendanceWeek,
} from "@/lib/domain/payroll-calc";
import {
  copyPriorWeekAsDraft,
  resetWorkerDayToTeam,
  upsertTeamDay,
  upsertWorkerAttendanceOverride,
} from "@/lib/data/increment-c-repository";
import { en } from "@/i18n/en";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AttendancePanelProps {
  session: AuthSession;
  jobId: string;
  weekStartDate: string;
  workers: Worker[];
  roles: WorkerRole[];
  assignments: WorkerAssignment[];
  teamDays: TeamDay[];
  attendanceEntries: AttendanceEntry[];
  otherJobAttendance: AttendanceEntry[];
}

const DAY_STATUS_LABELS: Record<DayWorkStatus, string> = {
  worked: "Worked",
  partial: "Partial",
  no_work: "No work",
  unknown: "Unknown",
};

export function AttendancePanel({
  session,
  jobId,
  weekStartDate,
  workers,
  roles,
  assignments,
  teamDays,
  attendanceEntries,
  otherJobAttendance,
}: AttendancePanelProps) {
  const qc = useQueryClient();
  const {effectiveOnline,refreshOfflineState}=useOfflineSync();
  const dates = useMemo(() => getWeekDates(weekStartDate), [weekStartDate]);
  const weekEndDate = dates[6]!;
  const roleMap = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const teamByDate = useMemo(() => new Map(teamDays.map((t) => [t.workDate, t])), [teamDays]);

  const assignedWorkers = useMemo(
    () =>
      workers.filter((w) =>
        assignments.some(
          (a) =>
            a.workerId === w.id &&
            a.jobId === jobId &&
            a.assignedFrom <= weekEndDate &&
            (a.assignedTo === null || a.assignedTo >= weekStartDate),
        ),
      ),
    [workers, assignments, jobId, weekStartDate, weekEndDate],
  );

  const issues = useMemo(
    () =>
      validateAttendanceWeek({
        weekStartDate,
        jobId,
        workers,
        roles,
        assignments,
        teamDays,
        attendanceEntries,
        otherJobAttendance,
      }),
    [weekStartDate, jobId, workers, roles, assignments, teamDays, attendanceEntries, otherJobAttendance],
  );

  const [selectedDay, setSelectedDay] = useState(dates[0]!);
  const activeDate = dates.includes(selectedDay) ? selectedDay : dates[0]!;
  const currentTeamDay = teamByDate.get(activeDate);

  // Individual exception editor state
  const [exWorkerId, setExWorkerId] = useState("");
  const activeWorkerId = exWorkerId || assignedWorkers[0]?.id || "";
  const [exDate, setExDate] = useState(dates[0]!);
  const activeExDate = dates.includes(exDate) ? exDate : dates[0]!;
  const [exStatus, setExStatus] = useState<DayWorkStatus>("no_work");
  const [exNormal, setExNormal] = useState("0");
  const [exOt, setExOt] = useState("0");
  const [exSat, setExSat] = useState("0");
  const [exSun, setExSun] = useState("0");
  const [exPh, setExPh] = useState("0");
  const [exReason, setExReason] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["attendance", session.businessId, jobId, weekStartDate] });
    qc.invalidateQueries({ queryKey: ["payroll-runs", session.businessId, jobId] });
  };

  const saveTeamDayMutation = useMutation({
    mutationFn: async (payload: Parameters<typeof upsertTeamDay>[1]) => {
      const base=teamByDate.get(payload.workDate)?.revision??0;
      if(!effectiveOnline){await enqueueOfflineMutation(session,{entityType:'attendance',operation:'update',label:`Team attendance ${payload.workDate}`,payload:{kind:'team',input:payload},baseRevision:base});await refreshOfflineState();return 'queued';}
      const result=await applyOperationalCapture(session,'team',payload as unknown as Record<string,unknown>,base,crypto.randomUUID());if(result.status==='conflict')throw new Error('Attendance changed on another device. Refresh before saving.');return 'saved';
    },
    onSuccess: (status) => {
      invalidate();
      toast.success(status === "queued" ? "Saved on phone — awaiting sync." : "Team day saved to server (individual exceptions preserved).");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const copyPriorMutation = useMutation({
    mutationFn: () => copyPriorWeekAsDraft(session, jobId, weekStartDate),
    onSuccess: (count) => {
      invalidate();
      toast.success(
        count > 0
          ? `Copied ${count} team day(s) from prior week as draft.`
          : "No team days found in prior week to copy.",
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const saveExceptionMutation = useMutation({
    mutationFn: async () => {
      if (!activeWorkerId) throw new Error("Select a worker.");
      const input = {
        jobId,
        workerId: activeWorkerId,
        workDate: activeExDate,
        dayStatus: exStatus,
        normalHours: Number(exNormal) || 0,
        weekdayOtHours: Number(exOt) || 0,
        saturdayHours: Number(exSat) || 0,
        sundayHours: Number(exSun) || 0,
        publicHolidayHours: Number(exPh) || 0,
        overrideReason: exReason || "Individual schedule entry",
      };
      const base=attendanceEntries.find(a=>a.workerId===activeWorkerId&&a.workDate===activeExDate)?.revision??0;
      if(!effectiveOnline){await enqueueOfflineMutation(session,{entityType:'attendance',operation:'update',label:`Worker attendance ${activeExDate}`,payload:{kind:'exception',input},baseRevision:base});await refreshOfflineState();return 'queued';}
      const result=await applyOperationalCapture(session,'exception',input,base,crypto.randomUUID());if(result.status==='conflict')throw new Error('Worker attendance changed; refresh before saving.');return 'saved';
    },
    onSuccess: (status) => {
      invalidate();
      toast.success(status === "queued" ? "Saved on phone — awaiting sync." : "Worker attendance saved to server.");
      setExReason("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetExceptionMutation = useMutation({
    mutationFn: ({ workerId, workDate }: { workerId: string; workDate: string }) =>
      effectiveOnline ? resetWorkerDayToTeam(session, jobId, workerId, workDate) : Promise.reject(new Error("Reconnect before resetting an exception.")),
    onSuccess: () => {
      invalidate();
      toast.success("Reset worker day back to team pattern.");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const quickSetTeamDay = (workDate: string, status: DayWorkStatus, normalHours: number) => {
    const existing = teamByDate.get(workDate);
    saveTeamDayMutation.mutate({
      jobId,
      workDate,
      dayStatus: status,
      normalHours,
      weekdayOtHours: existing?.weekdayOtHours ?? 0,
      saturdayHours: existing?.saturdayHours ?? 0,
      sundayHours: existing?.sundayHours ?? 0,
      publicHolidayHours: existing?.publicHolidayHours ?? 0,
      interruptionReason: status === "no_work" || status === "partial" ? (existing?.interruptionReason ?? null) : null,
      notes: existing?.notes ?? "",
    });
  };

  const unknownCount = issues.filter((i) => i.severity === "warning").length;
  const errorIssues = issues.filter((i) => i.severity === "error");

  return (
    <div className="space-y-6">
      {errorIssues.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p className="font-semibold">Attendance validation errors ({errorIssues.length})</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {errorIssues.slice(0, 5).map((e, idx) => (
              <li key={idx}>
                {e.workerName} ({e.workDate}): {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unknownCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-status-warn/40 bg-status-warn-bg p-3 text-sm text-status-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {unknownCount} worker-day(s) are still marked <strong>Unknown</strong>.{" "}
            {en.payroll.unknownWarning}
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-lg">Team pattern (Mon–Sun)</CardTitle>
            <CardDescription>
              Crew roles inherit this pattern unless overridden. Changing a team day preserves individual exceptions.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            className="touch-target gap-2"
            disabled={copyPriorMutation.isPending || !effectiveOnline}
            onClick={() => copyPriorMutation.mutate()}
          >
            <Copy className="h-4 w-4" />
            {en.payroll.copyPriorWeek}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-7">
            {dates.map((d) => {
              const td = teamByDate.get(d);
              const status: DayWorkStatus = td?.dayStatus ?? "unknown";
              const isSelected = d === activeDate;
              return (
                <div
                  key={d}
                  className={`flex flex-col justify-between rounded-md border p-2.5 text-xs ${
                    isSelected ? "border-primary bg-primary/5" : "border-border bg-card"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedDay(d)}
                    className="text-left"
                  >
                    <p className="font-semibold">{format(parseISO(d), "EEE dd")}</p>
                    <Badge
                      variant={
                        status === "worked"
                          ? "default"
                          : status === "unknown"
                            ? "destructive"
                            : "outline"
                      }
                      className="mt-1 text-[10px]"
                    >
                      {DAY_STATUS_LABELS[status]}
                      {td && td.normalHours > 0 ? ` · ${td.normalHours}h` : ""}
                    </Badge>
                  </button>
                  <div className="mt-2 flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 flex-1 px-1 text-[11px]"
                      onClick={() => quickSetTeamDay(d, "worked", 9)}
                    >
                      9h
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 flex-1 px-1 text-[11px]"
                      onClick={() => quickSetTeamDay(d, "no_work", 0)}
                    >
                      Off
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <TeamDayDetailForm
            key={activeDate + (currentTeamDay?.updatedAt ?? "")}
            workDate={activeDate}
            existing={currentTeamDay}
            saving={saveTeamDayMutation.isPending}
            onSave={(vals) => saveTeamDayMutation.mutate({ jobId, workDate: activeDate, ...vals })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Assigned workers &amp; individual exceptions</CardTitle>
          <CardDescription>
            Non-crew roles (such as Camp cook) maintain their own schedule. Override any worker day or reset to team pattern.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 pr-3 font-semibold">Worker</th>
                  {dates.map((d) => (
                    <th key={d} className="px-1.5 py-2 text-center font-semibold">
                      {format(parseISO(d), "EEE")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assignedWorkers.map((w) => {
                  const role = roleMap.get(w.workerRoleId);
                  const sharesCrew = role?.sharesCrewSchedule ?? true;
                  return (
                    <tr key={w.id} className="border-b border-border/60">
                      <td className="py-2.5 pr-3">
                        <p className="font-semibold text-foreground">{w.fullName}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {role?.name ?? "Role"} · {sharesCrew ? "Team schedule" : "Own schedule"}
                        </p>
                      </td>
                      {dates.map((d) => {
                        const entry = attendanceEntries.find(
                          (e) => e.workerId === w.id && e.workDate === d,
                        );
                        const eff = resolveEffectiveWorkerDay(
                          d,
                          entry,
                          teamByDate.get(d),
                          sharesCrew,
                        );
                        const extra =
                          eff.weekdayOtHours +
                          eff.saturdayHours +
                          eff.sundayHours +
                          eff.publicHolidayHours;
                        return (
                          <td key={d} className="px-1 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => {
                                setExWorkerId(w.id);
                                setExDate(d);
                                setExStatus(eff.dayStatus);
                                setExNormal(String(eff.normalHours));
                                setExOt(String(eff.weekdayOtHours));
                                setExSat(String(eff.saturdayHours));
                                setExSun(String(eff.sundayHours));
                                setExPh(String(eff.publicHolidayHours));
                                setExReason(eff.overrideReason ?? "");
                              }}
                              className={`w-full rounded border px-1 py-1 text-[11px] ${
                                eff.dayStatus === "unknown"
                                  ? "border-status-warn/60 bg-status-warn-bg text-status-warn"
                                  : eff.isOverride
                                    ? "border-primary bg-primary/10 font-semibold text-foreground"
                                    : "border-border bg-muted/40 text-foreground"
                              }`}
                            >
                              <div>
                                {eff.dayStatus === "worked"
                                  ? `${eff.normalHours}h`
                                  : eff.dayStatus === "partial"
                                    ? `P ${eff.normalHours}h`
                                    : eff.dayStatus === "no_work"
                                      ? "Off"
                                      : "?"}
                              </div>
                              {extra > 0 && <div className="text-[10px]">+{extra}h</div>}
                              {eff.isOverride && <div className="text-[9px] uppercase">Ex</div>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border border-border bg-muted/20 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <UserCheck className="h-4 w-4" />
                Edit worker exception / own schedule day
              </p>
              {activeWorkerId &&
                attendanceEntries.some(
                  (e) => e.workerId === activeWorkerId && e.workDate === activeExDate,
                ) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 gap-1.5"
                    onClick={() =>
                      resetExceptionMutation.mutate({
                        workerId: activeWorkerId,
                        workDate: activeExDate,
                      })
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset to team
                  </Button>
                )}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="ex-worker">Worker</Label>
                <select
                  id="ex-worker"
                  value={activeWorkerId}
                  onChange={(e) => setExWorkerId(e.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {assignedWorkers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ex-date">Day</Label>
                <select
                  id="ex-date"
                  value={activeExDate}
                  onChange={(e) => setExDate(e.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {dates.map((d) => (
                    <option key={d} value={d}>
                      {format(parseISO(d), "EEE dd MMM yyyy")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ex-status">Status</Label>
                <select
                  id="ex-status"
                  value={exStatus}
                  onChange={(e) => setExStatus(e.target.value as DayWorkStatus)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="worked">Worked</option>
                  <option value="partial">Partial</option>
                  <option value="no_work">No work / absent</option>
                  <option value="unknown">Unknown</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="space-y-1">
                <Label htmlFor="ex-norm">Normal hrs</Label>
                <Input id="ex-norm" type="number" min={0} max={24} step={0.5} value={exNormal} onChange={(e) => setExNormal(e.target.value)} className="h-11" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ex-ot">Weekday OT</Label>
                <Input id="ex-ot" type="number" min={0} max={24} step={0.5} value={exOt} onChange={(e) => setExOt(e.target.value)} className="h-11" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ex-sat">Sat hrs</Label>
                <Input id="ex-sat" type="number" min={0} max={24} step={0.5} value={exSat} onChange={(e) => setExSat(e.target.value)} className="h-11" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ex-sun">Sun hrs</Label>
                <Input id="ex-sun" type="number" min={0} max={24} step={0.5} value={exSun} onChange={(e) => setExSun(e.target.value)} className="h-11" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ex-ph">Public hol</Label>
                <Input id="ex-ph" type="number" min={0} max={24} step={0.5} value={exPh} onChange={(e) => setExPh(e.target.value)} className="h-11" />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1 space-y-1">
                <Label htmlFor="ex-reason">Override / schedule reason</Label>
                <Input id="ex-reason" value={exReason} onChange={(e) => setExReason(e.target.value)} placeholder="e.g. Absent unpaid, clinic visit, or cook shift" className="h-11" />
              </div>
              <Button
                type="button"
                className="touch-target gap-2"
                disabled={saveExceptionMutation.isPending}
                onClick={() => saveExceptionMutation.mutate()}
              >
                <CheckCircle2 className="h-4 w-4" />
                Save exception
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TeamDayDetailForm({
  workDate,
  existing,
  saving,
  onSave,
}: {
  workDate: string;
  existing: TeamDay | undefined;
  saving: boolean;
  onSave: (vals: {
    dayStatus: DayWorkStatus;
    normalHours: number;
    weekdayOtHours: number;
    saturdayHours: number;
    sundayHours: number;
    publicHolidayHours: number;
    interruptionReason: InterruptionReason | null;
    notes: string;
  }) => void;
}) {
  const [dayStatus, setDayStatus] = useState<DayWorkStatus>(existing?.dayStatus ?? "unknown");
  const [normalHours, setNormalHours] = useState(String(existing?.normalHours ?? 0));
  const [weekdayOtHours, setWeekdayOtHours] = useState(String(existing?.weekdayOtHours ?? 0));
  const [saturdayHours, setSaturdayHours] = useState(String(existing?.saturdayHours ?? 0));
  const [sundayHours, setSundayHours] = useState(String(existing?.sundayHours ?? 0));
  const [publicHolidayHours, setPublicHolidayHours] = useState(
    String(existing?.publicHolidayHours ?? 0),
  );
  const [interruptionReason, setInterruptionReason] = useState<string>(
    existing?.interruptionReason ?? "",
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Edit team day: {format(parseISO(workDate), "EEEE dd MMM yyyy")}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="td-status">Day status</Label>
          <select
            id="td-status"
            value={dayStatus}
            onChange={(e) => setDayStatus(e.target.value as DayWorkStatus)}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="worked">Worked</option>
            <option value="partial">Partial</option>
            <option value="no_work">No work</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-int">Interruption reason (if any)</Label>
          <select
            id="td-int"
            value={interruptionReason}
            onChange={(e) => setInterruptionReason(e.target.value)}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">None</option>
            {(Object.keys(INTERRUPTION_REASON_LABELS) as InterruptionReason[]).map((k) => (
              <option key={k} value={k}>
                {INTERRUPTION_REASON_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-notes">Notes</Label>
          <Input id="td-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="h-11" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <div className="space-y-1">
          <Label htmlFor="td-norm">Normal</Label>
          <Input id="td-norm" type="number" min={0} max={24} step={0.5} value={normalHours} onChange={(e) => setNormalHours(e.target.value)} className="h-11" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-ot">Wkdy OT</Label>
          <Input id="td-ot" type="number" min={0} max={24} step={0.5} value={weekdayOtHours} onChange={(e) => setWeekdayOtHours(e.target.value)} className="h-11" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-sat">Sat</Label>
          <Input id="td-sat" type="number" min={0} max={24} step={0.5} value={saturdayHours} onChange={(e) => setSaturdayHours(e.target.value)} className="h-11" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-sun">Sun</Label>
          <Input id="td-sun" type="number" min={0} max={24} step={0.5} value={sundayHours} onChange={(e) => setSundayHours(e.target.value)} className="h-11" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="td-ph">Pub hol</Label>
          <Input id="td-ph" type="number" min={0} max={24} step={0.5} value={publicHolidayHours} onChange={(e) => setPublicHolidayHours(e.target.value)} className="h-11" />
        </div>
        <Button
          type="button"
          className="touch-target self-end"
          disabled={saving}
          onClick={() =>
            onSave({
              dayStatus,
              normalHours: Number(normalHours) || 0,
              weekdayOtHours: Number(weekdayOtHours) || 0,
              saturdayHours: Number(saturdayHours) || 0,
              sundayHours: Number(sundayHours) || 0,
              publicHolidayHours: Number(publicHolidayHours) || 0,
              interruptionReason: (interruptionReason || null) as InterruptionReason | null,
              notes,
            })
          }
        >
          Save day
        </Button>
      </div>
    </div>
  );
}