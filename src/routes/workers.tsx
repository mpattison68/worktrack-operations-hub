import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Plus, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import {
  closePayRule,
  createPayRule,
  createWorkerAssignment,
  createWorkerRole,
  listJobs,
  listWorkforceBundle,
  requestRateOverride,
  reviewRateOverride,
  saveWorker,
} from "@/lib/data/repository";
import { can } from "@/lib/permissions";
import { formatDateSA, formatZarCents, parseZarToCents, todaySAST } from "@/lib/format";
import type { PayBasis, Worker, WorkerRoleType } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

const ROLE_TYPES: WorkerRoleType[] = [
  "road_worker",
  "supervisor",
  "driver",
  "cook",
  "admin",
  "owner",
  "other",
];

export const Route = createFileRoute("/workers")({
  head: () => ({
    meta: [
      { title: "Workers, roles & rates — WorkTrack" },
      { name: "description", content: "Manage worker roster, effective-dated role pay rules, and job assignments." },
      { property: "og:title", content: "Workers, roles & rates — WorkTrack" },
      { property: "og:description", content: "Manage worker roster, effective-dated role pay rules, and job assignments." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WorkersPage,
});

function WorkersPage() {
  const { session } = useWorkTrackAuth();
  const queryClient = useQueryClient();

  const [workerDialog, setWorkerDialog] = React.useState(false);
  const [editingWorker, setEditingWorker] = React.useState<Worker | null>(null);
  const [wName, setWName] = React.useState("");
  const [wPhone, setWPhone] = React.useState("");
  const [wRoleId, setWRoleId] = React.useState("");
  const [wStartDate, setWStartDate] = React.useState(todaySAST());
  const [wActive, setWActive] = React.useState(true);
  const [wOpeningRand, setWOpeningRand] = React.useState("0");
  const [wOpeningSource, setWOpeningSource] = React.useState("");

  const [roleDialog, setRoleDialog] = React.useState(false);
  const [rName, setRName] = React.useState("");
  const [rType, setRType] = React.useState<WorkerRoleType>("road_worker");
  const [rSharesCrew, setRSharesCrew] = React.useState(true);

  const [ruleDialog, setRuleDialog] = React.useState(false);
  const [prRoleId, setPrRoleId] = React.useState("");
  const [prBasis, setPrBasis] = React.useState<PayBasis>("daily");
  const [prRateRand, setPrRateRand] = React.useState("");
  const [prHours, setPrHours] = React.useState("9");
  const [prDays, setPrDays] = React.useState("5");
  const [prFrom, setPrFrom] = React.useState(todaySAST());
  const [prConfirmed, setPrConfirmed] = React.useState(false);
  const [prNotes, setPrNotes] = React.useState("");

  const [overrideDialog, setOverrideDialog] = React.useState(false);
  const [ovWorkerId, setOvWorkerId] = React.useState("");
  const [ovBasis, setOvBasis] = React.useState<PayBasis>("daily");
  const [ovRateRand, setOvRateRand] = React.useState("");
  const [ovFrom, setOvFrom] = React.useState(todaySAST());
  const [ovReason, setOvReason] = React.useState("");

  const [assignWorkerId, setAssignWorkerId] = React.useState("");
  const [assignJobId, setAssignJobId] = React.useState("");
  const [assignFrom, setAssignFrom] = React.useState(todaySAST());

  const workforceQuery = useQuery({
    queryKey: ["workforce", session?.businessId, session?.userId],
    queryFn: () => listWorkforceBundle(session!),
    enabled: Boolean(session),
  });

  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["workforce"] });
    queryClient.invalidateQueries({ queryKey: ["audit"] });
  };

  const workerMutation = useMutation({
    mutationFn: async () => {
      const openingCents = parseZarToCents(wOpeningRand);
      if (openingCents === null) throw new Error("Enter a valid ZAR opening balance (negative for advance).");
      return saveWorker(session!, {
        ...(editingWorker ? { id: editingWorker.id } : {}),
        fullName: wName,
        contactPhone: wPhone || null,
        workerRoleId: wRoleId,
        employmentStartDate: wStartDate,
        employmentEndDate: wActive ? null : todaySAST(),
        active: wActive,
        openingBalanceCents: openingCents,
        openingBalanceSource: wOpeningSource,
      });
    },
    onSuccess: () => {
      invalidate();
      toast.success(editingWorker ? "Worker updated." : "Worker added.");
      setWorkerDialog(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save worker."),
  });

  const roleMutation = useMutation({
    mutationFn: () =>
      createWorkerRole(session!, { roleType: rType, name: rName, sharesCrewSchedule: rSharesCrew }),
    onSuccess: () => {
      invalidate();
      toast.success("Worker role created.");
      setRoleDialog(false);
      setRName("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create role."),
  });

  const ruleMutation = useMutation({
    mutationFn: async () => {
      const cents = parseZarToCents(prRateRand);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR base rate.");
      return createPayRule(session!, {
        workerRoleId: prRoleId,
        payBasis: prBasis,
        baseRateCents: cents,
        normalHoursPerDay: Number(prHours),
        normalWorkdaysPerWeek: Number(prDays),
        weekdayOtHourlyCents: null,
        saturdayRateCents: null,
        sundayRateCents: null,
        publicHolidayRateCents: null,
        weeklyProrationPolicy: prBasis === "weekly" ? "full_week_entitlement" : "none",
        effectiveFrom: prFrom,
        effectiveTo: null,
        isConfirmed: prConfirmed,
        notes: prNotes,
      });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Effective-dated pay rule added.");
      setRuleDialog(false);
      setPrRateRand("");
      setPrNotes("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add pay rule."),
  });

  const closeRuleMutation = useMutation({
    mutationFn: (ruleId: string) => closePayRule(session!, ruleId, todaySAST()),
    onSuccess: () => {
      invalidate();
      toast.success("Pay rule end-dated. You can now add a new effective rate starting tomorrow.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not close pay rule."),
  });

  const overrideMutation = useMutation({
    mutationFn: async () => {
      const cents = parseZarToCents(ovRateRand);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR rate.");
      return requestRateOverride(session!, {
        workerId: ovWorkerId,
        payBasis: ovBasis,
        proposedRateCents: cents,
        effectiveFrom: ovFrom,
        reason: ovReason,
      });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Rate change request submitted for Admin review.");
      setOverrideDialog(false);
      setOvRateRand("");
      setOvReason("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not submit request."),
  });

  const reviewOverrideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "declined" }) =>
      reviewRateOverride(session!, id, decision),
    onSuccess: () => {
      invalidate();
      toast.success("Rate override updated.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not review request."),
  });

  const assignMutation = useMutation({
    mutationFn: () =>
      createWorkerAssignment(session!, {
        workerId: assignWorkerId,
        jobId: assignJobId,
        assignedFrom: assignFrom,
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Worker assigned to job.");
      setAssignWorkerId("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not assign worker."),
  });

  if (!session) return null;

  const roles = workforceQuery.data?.roles ?? [];
  const payRules = workforceQuery.data?.payRules ?? [];
  const workers = workforceQuery.data?.workers ?? [];
  const overrides = workforceQuery.data?.rateOverrides ?? [];
  const assignments = workforceQuery.data?.assignments ?? [];
  const jobs = jobsQuery.data ?? [];

  const canViewRates = can(session.role, "rates.view");
  const canEditRates = can(session.role, "rates.edit");
  const canAddWorker = can(session.role, "workers.add");
  const canEditWorker = can(session.role, "workers.edit");
  const canRequestOverride = can(session.role, "rates.request_override");
  const canApproveOverride = can(session.role, "rates.approve_override");

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "Unknown role";
  const workerName = (id: string) => workers.find((w) => w.id === id)?.fullName ?? "Unknown worker";
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? "Unknown job";

  const openNewWorker = () => {
    setEditingWorker(null);
    setWName("");
    setWPhone("");
    setWRoleId(roles[0]?.id ?? "");
    setWStartDate(todaySAST());
    setWActive(true);
    setWOpeningRand("0");
    setWOpeningSource("");
    setWorkerDialog(true);
  };

  const openEditWorker = (w: Worker) => {
    setEditingWorker(w);
    setWName(w.fullName);
    setWPhone(w.contactPhone ?? "");
    setWRoleId(w.workerRoleId);
    setWStartDate(w.employmentStartDate);
    setWActive(w.active);
    setWOpeningRand((w.openingBalanceCents / 100).toFixed(2));
    setWOpeningSource(w.openingBalanceSource);
    setWorkerDialog(true);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{en.workers.title}</h1>
          <p className="text-sm text-muted-foreground">{en.workers.subtitle}</p>
        </div>
        {canAddWorker && (
          <Button onClick={openNewWorker} className="touch-target gap-2">
            <UserPlus className="h-4 w-4" />
            {en.workers.addWorker}
          </Button>
        )}
      </div>

      <Tabs defaultValue="roster" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 sm:w-auto sm:inline-flex">
          <TabsTrigger value="roster" className="touch-target">{en.workers.tabRoster}</TabsTrigger>
          {canViewRates && (
            <TabsTrigger value="roles" className="touch-target">{en.workers.tabRoles}</TabsTrigger>
          )}
          <TabsTrigger value="assignments" className="touch-target">{en.workers.tabAssignments}</TabsTrigger>
        </TabsList>

        {/* TAB 1: WORKER ROSTER */}
        <TabsContent value="roster" className="space-y-3">
          {workers.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No workers found for your access scope.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {workers.map((w) => (
                <Card key={w.id} className={w.active ? "" : "opacity-80"}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-foreground">{w.fullName}</p>
                        <p className="text-xs text-muted-foreground">
                          {roleName(w.workerRoleId)} · Started {formatDateSA(w.employmentStartDate)}
                          {w.employmentEndDate ? ` · Ended ${formatDateSA(w.employmentEndDate)}` : ""}
                        </p>
                      </div>
                      <Badge variant={w.active ? "default" : "secondary"}>
                        {w.active ? en.common.active : en.common.former}
                      </Badge>
                    </div>
                    {w.contactPhone && (
                      <p className="text-xs text-muted-foreground">Phone: {w.contactPhone}</p>
                    )}
                    {canViewRates && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/50 px-2.5 py-2 text-xs">
                        <span>
                          Opening balance:{" "}
                          <strong className="tabular-money">{formatZarCents(w.openingBalanceCents)}</strong>{" "}
                          ({w.openingBalanceVerified ? "Verified" : "Unverified"})
                        </span>
                        <div className="flex gap-1.5">
                          {canRequestOverride && w.active && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setOvWorkerId(w.id);
                                setOverrideDialog(true);
                              }}
                              className="h-9 text-xs"
                            >
                              {en.workers.requestRateChange}
                            </Button>
                          )}
                          {canEditWorker && (
                            <Button variant="ghost" size="sm" onClick={() => openEditWorker(w)} className="h-9 text-xs">
                              {en.common.edit}
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* TAB 2: ROLES & EFFECTIVE-DATED RATES */}
        {canViewRates && (
          <TabsContent value="roles" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-status-warn">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{en.workers.unconfirmedWarning}</span>
              </div>
              {canEditRates && (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setRoleDialog(true)} className="touch-target gap-1.5">
                    <Plus className="h-4 w-4" />
                    {en.workers.addRole}
                  </Button>
                  <Button
                    onClick={() => {
                      setPrRoleId(roles[0]?.id ?? "");
                      setRuleDialog(true);
                    }}
                    className="touch-target gap-1.5"
                  >
                    <Plus className="h-4 w-4" />
                    {en.workers.addPayRule}
                  </Button>
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {roles.map((role) => {
                const roleRules = payRules.filter((r) => r.workerRoleId === role.id);
                return (
                  <Card key={role.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">{role.name}</CardTitle>
                        <Badge variant="outline">{role.roleType.replace(/_/g, " ")}</Badge>
                      </div>
                      <CardDescription className="text-xs">
                        {role.sharesCrewSchedule ? "Shares crew schedule" : "Separate schedule"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {roleRules.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No pay rate configured yet.</p>
                      ) : (
                        roleRules.map((pr) => (
                          <div key={pr.id} className="space-y-1 rounded-md border border-border p-2.5 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold tabular-money">
                                {formatZarCents(pr.baseRateCents)} / {pr.payBasis}
                              </span>
                              <Badge
                                variant="outline"
                                className={
                                  pr.isConfirmed
                                    ? "bg-status-ok-bg text-status-ok"
                                    : "bg-status-warn-bg text-status-warn"
                                }
                              >
                                {pr.isConfirmed ? en.common.confirmed : en.common.unconfirmed}
                              </Badge>
                            </div>
                            <p className="text-muted-foreground">
                              Effective {formatDateSA(pr.effectiveFrom)} to{" "}
                              {pr.effectiveTo ? formatDateSA(pr.effectiveTo) : "open"} ·{" "}
                              {pr.normalHoursPerDay}h/day, {pr.normalWorkdaysPerWeek}d/wk
                            </p>
                            {pr.notes && <p className="text-muted-foreground">{pr.notes}</p>}
                            {canEditRates && pr.effectiveTo === null && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => closeRuleMutation.mutate(pr.id)}
                                className="mt-1 h-8 px-2 text-xs"
                              >
                                End-date today to schedule a new rate
                              </Button>
                            )}
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {overrides.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Individual rate override requests</CardTitle>
                  <CardDescription className="text-xs">
                    Owner can request; Management / Admin must approve before payroll use.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {overrides.map((ov) => (
                    <div key={ov.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-xs">
                      <div>
                        <p className="font-semibold text-foreground">
                          {workerName(ov.workerId)} —{" "}
                          <span className="tabular-money">{formatZarCents(ov.proposedRateCents)}</span> / {ov.payBasis}
                        </p>
                        <p className="text-muted-foreground">
                          From {formatDateSA(ov.effectiveFrom)} · Reason: {ov.reason} · By {ov.requestedBy}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{ov.status}</Badge>
                        {canApproveOverride && ov.status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => reviewOverrideMutation.mutate({ id: ov.id, decision: "approved" })}
                              className="h-9 gap-1"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => reviewOverrideMutation.mutate({ id: ov.id, decision: "declined" })}
                              className="h-9 gap-1"
                            >
                              <X className="h-3.5 w-3.5" />
                              Decline
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

        {/* TAB 3: JOB ASSIGNMENTS */}
        <TabsContent value="assignments" className="space-y-4">
          {canAddWorker && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{en.workers.addAssignment}</CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    assignMutation.mutate();
                  }}
                  className="grid gap-3 sm:grid-cols-4"
                >
                  <Select value={assignWorkerId} onValueChange={setAssignWorkerId}>
                    <SelectTrigger className="touch-target"><SelectValue placeholder="Select worker" /></SelectTrigger>
                    <SelectContent>
                      {workers.filter((w) => w.active).map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.fullName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={assignJobId} onValueChange={setAssignJobId}>
                    <SelectTrigger className="touch-target"><SelectValue placeholder="Select job" /></SelectTrigger>
                    <SelectContent>
                      {jobs.map((j) => (
                        <SelectItem key={j.id} value={j.id}>{j.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input type="date" value={assignFrom} onChange={(e) => setAssignFrom(e.target.value)} className="touch-target" />
                  <Button type="submit" disabled={assignMutation.isPending} className="touch-target">
                    Assign
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          <div className="space-y-2">
            {assignments.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card p-3 text-sm">
                <div>
                  <p className="font-medium">{workerName(a.workerId)}</p>
                  <p className="text-xs text-muted-foreground">
                    {jobName(a.jobId)} · From {formatDateSA(a.assignedFrom)}
                  </p>
                </div>
                <Badge variant={a.active ? "default" : "secondary"}>
                  {a.active ? en.common.active : "Ended"}
                </Badge>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Add/Edit Worker Dialog */}
      <Dialog open={workerDialog} onOpenChange={setWorkerDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingWorker ? "Edit worker" : en.workers.addWorker}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); workerMutation.mutate(); }} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="w-name">Full name</Label>
              <Input id="w-name" value={wName} onChange={(e) => setWName(e.target.value)} className="touch-target" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="w-phone">Contact phone (optional)</Label>
              <Input id="w-phone" value={wPhone} onChange={(e) => setWPhone(e.target.value)} className="touch-target" />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={wRoleId} onValueChange={setWRoleId}>
                <SelectTrigger className="touch-target"><SelectValue placeholder="Choose role" /></SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="w-start">Start date</Label>
                <Input id="w-start" type="date" value={wStartDate} onChange={(e) => setWStartDate(e.target.value)} className="touch-target" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="w-open">Opening arrears/advance (ZAR)</Label>
                <Input id="w-open" inputMode="decimal" value={wOpeningRand} onChange={(e) => setWOpeningRand(e.target.value)} className="touch-target tabular-money" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="w-src">Opening balance source note</Label>
              <Input id="w-src" value={wOpeningSource} onChange={(e) => setWOpeningSource(e.target.value)} className="touch-target" />
            </div>
            {editingWorker && (
              <div className="flex items-center gap-2 pt-1">
                <Checkbox id="w-active" checked={wActive} onCheckedChange={(v) => setWActive(Boolean(v))} />
                <Label htmlFor="w-active">Active worker (uncheck to preserve as former worker)</Label>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setWorkerDialog(false)} className="touch-target">{en.common.cancel}</Button>
              <Button type="submit" disabled={workerMutation.isPending} className="touch-target">{en.common.save}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Role Dialog */}
      <Dialog open={roleDialog} onOpenChange={setRoleDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{en.workers.addRole}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); roleMutation.mutate(); }} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="r-name">Role display name</Label>
              <Input id="r-name" value={rName} onChange={(e) => setRName(e.target.value)} className="touch-target" required />
            </div>
            <div className="space-y-1">
              <Label>Role template</Label>
              <Select value={rType} onValueChange={(v) => setRType(v as WorkerRoleType)}>
                <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="r-crew" checked={rSharesCrew} onCheckedChange={(v) => setRSharesCrew(Boolean(v))} />
              <Label htmlFor="r-crew">Shares road crew weekly schedule</Label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setRoleDialog(false)} className="touch-target">{en.common.cancel}</Button>
              <Button type="submit" disabled={roleMutation.isPending} className="touch-target">{en.common.save}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Pay Rule Dialog */}
      <Dialog open={ruleDialog} onOpenChange={setRuleDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{en.workers.addPayRule}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); ruleMutation.mutate(); }} className="space-y-3">
            <div className="space-y-1">
              <Label>Worker role</Label>
              <Select value={prRoleId} onValueChange={setPrRoleId}>
                <SelectTrigger className="touch-target"><SelectValue placeholder="Choose role" /></SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (<SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Pay basis</Label>
                <Select value={prBasis} onValueChange={(v) => setPrBasis(v as PayBasis)}>
                  <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-rate">Base rate (ZAR)</Label>
                <Input id="pr-rate" inputMode="decimal" value={prRateRand} onChange={(e) => setPrRateRand(e.target.value)} className="touch-target tabular-money" required />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="pr-hrs">Hours/day</Label>
                <Input id="pr-hrs" type="number" step="0.5" value={prHours} onChange={(e) => setPrHours(e.target.value)} className="touch-target" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-days">Days/wk</Label>
                <Input id="pr-days" type="number" value={prDays} onChange={(e) => setPrDays(e.target.value)} className="touch-target" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-from">Effective from</Label>
                <Input id="pr-from" type="date" value={prFrom} onChange={(e) => setPrFrom(e.target.value)} className="touch-target" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pr-notes">Notes (OT/weekend terms)</Label>
              <Input id="pr-notes" value={prNotes} onChange={(e) => setPrNotes(e.target.value)} className="touch-target" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="pr-conf" checked={prConfirmed} onCheckedChange={(v) => setPrConfirmed(Boolean(v))} />
              <Label htmlFor="pr-conf">Admin-confirmed against SA employment terms</Label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setRuleDialog(false)} className="touch-target">{en.common.cancel}</Button>
              <Button type="submit" disabled={ruleMutation.isPending} className="touch-target">{en.common.save}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Request Rate Override Dialog */}
      <Dialog open={overrideDialog} onOpenChange={setOverrideDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{en.workers.requestRateChange}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); overrideMutation.mutate(); }} className="space-y-3">
            <p className="text-xs text-muted-foreground">Worker: <strong>{workerName(ovWorkerId)}</strong></p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Pay basis</Label>
                <Select value={ovBasis} onValueChange={(v) => setOvBasis(v as PayBasis)}>
                  <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ov-rate">Proposed rate (ZAR)</Label>
                <Input id="ov-rate" inputMode="decimal" value={ovRateRand} onChange={(e) => setOvRateRand(e.target.value)} className="touch-target tabular-money" required />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ov-from">Effective from</Label>
              <Input id="ov-from" type="date" value={ovFrom} onChange={(e) => setOvFrom(e.target.value)} className="touch-target" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ov-reason">Reason</Label>
              <Input id="ov-reason" value={ovReason} onChange={(e) => setOvReason(e.target.value)} className="touch-target" required />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOverrideDialog(false)} className="touch-target">{en.common.cancel}</Button>
              <Button type="submit" disabled={overrideMutation.isPending} className="touch-target">Submit request</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}