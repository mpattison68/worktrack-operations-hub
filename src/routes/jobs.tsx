import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Lock, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs, saveJob } from "@/lib/data/repository";
import { can } from "@/lib/permissions";
import { formatDateSA, formatZarCents, parseZarToCents } from "@/lib/format";
import type { Job, JobStatus, VatBasis } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const JOB_STATUSES: JobStatus[] = [
  "assessment_draft",
  "submitted",
  "returned",
  "approved",
  "planned",
  "active",
  "work_complete",
  "customer_accepted",
  "financially_closed",
  "on_hold",
  "cancelled",
];

const VAT_OPTIONS: Array<{ value: VatBasis; label: string }> = [
  { value: "not_registered", label: "Not VAT registered" },
  { value: "exclusive", label: "VAT exclusive (15%)" },
  { value: "inclusive", label: "VAT inclusive (15%)" },
  { value: "exempt", label: "VAT exempt" },
];

export const Route = createFileRoute("/jobs")({
  head: () => ({
    meta: [
      { title: "Jobs — WorkTrack" },
      { name: "description", content: "Manage road-verge clearing jobs and contract setup." },
      { property: "og:title", content: "Jobs — WorkTrack" },
      { property: "og:description", content: "Manage road-verge clearing jobs and contract setup." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: JobsPage,
});

function JobsPage() {
  const { session } = useWorkTrackAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingJob, setEditingJob] = React.useState<Job | null>(null);

  const [name, setName] = React.useState("");
  const [customerName, setCustomerName] = React.useState("");
  const [contractReference, setContractReference] = React.useState("");
  const [contractValueRand, setContractValueRand] = React.useState("0");
  const [vatBasis, setVatBasis] = React.useState<VatBasis>("not_registered");
  const [roadOrArea, setRoadOrArea] = React.useState("");
  const [status, setStatus] = React.useState<JobStatus>("planned");
  const [plannedStartDate, setPlannedStartDate] = React.useState("");
  const [plannedEndDate, setPlannedEndDate] = React.useState("");
  const [openingCashRand, setOpeningCashRand] = React.useState("0");
  const [workRequirements, setWorkRequirements] = React.useState("");

  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in.");
      const contractCents = parseZarToCents(contractValueRand);
      if (contractCents === null || contractCents < 0) {
        throw new Error("Enter a valid non-negative contract value in ZAR.");
      }
      const openingCents = parseZarToCents(openingCashRand);
      if (openingCents === null || openingCents < 0) {
        throw new Error("Enter a valid non-negative opening cash allocation in ZAR.");
      }
      return saveJob(session, {
        ...(editingJob ? { id: editingJob.id } : {}),
        name,
        customerName,
        contractReference,
        contractValueCents: contractCents,
        vatBasis,
        roadOrArea,
        status,
        plannedStartDate: plannedStartDate || null,
        plannedEndDate: plannedEndDate || null,
        openingCashAllocationCents: openingCents,
        workRequirements,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success(editingJob ? "Job updated." : "Job created.");
      setDialogOpen(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not save job.");
    },
  });

  if (!session) return null;

  const canManage = can(session.role, "jobs.manage");
  const canSeeMoney = can(session.role, "rates.view");
  const jobs = jobsQuery.data ?? [];

  const openCreate = () => {
    setEditingJob(null);
    setName("");
    setCustomerName("");
    setContractReference("");
    setContractValueRand("0");
    setVatBasis("not_registered");
    setRoadOrArea("");
    setStatus("planned");
    setPlannedStartDate("");
    setPlannedEndDate("");
    setOpeningCashRand("0");
    setWorkRequirements("");
    setDialogOpen(true);
  };

  const openEdit = (job: Job) => {
    setEditingJob(job);
    setName(job.name);
    setCustomerName(job.customerName);
    setContractReference(job.contractReference);
    setContractValueRand((job.contractValueCents / 100).toFixed(2));
    setVatBasis(job.vatBasis);
    setRoadOrArea(job.roadOrArea);
    setStatus(job.status);
    setPlannedStartDate(job.plannedStartDate ?? "");
    setPlannedEndDate(job.plannedEndDate ?? "");
    setOpeningCashRand((job.openingCashAllocationCents / 100).toFixed(2));
    setWorkRequirements(job.workRequirements);
    setDialogOpen(true);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{en.jobs.title}</h1>
          <p className="text-sm text-muted-foreground">{en.jobs.subtitle}</p>
        </div>
        {canManage && (
          <Button onClick={openCreate} className="touch-target gap-2">
            <Plus className="h-4 w-4" />
            {en.jobs.newJob}
          </Button>
        )}
      </div>

      {!canManage && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          <span>{en.jobs.readOnlyNotice}</span>
        </div>
      )}

      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {en.jobs.empty}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{job.name}</span>
                    </CardTitle>
                    <CardDescription className="mt-1">
                      {job.customerName}
                      {job.contractReference ? ` · Ref ${job.contractReference}` : ""}
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="shrink-0 capitalize">
                    {job.status.replace(/_/g, " ")}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/50 p-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">Road / area</p>
                    <p className="font-medium text-foreground">{job.roadOrArea}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Planned dates</p>
                    <p className="font-medium text-foreground">
                      {formatDateSA(job.plannedStartDate)} – {formatDateSA(job.plannedEndDate)}
                    </p>
                  </div>
                  {canSeeMoney && (
                    <>
                      <div>
                        <p className="text-muted-foreground">Contract value ({job.vatBasis.replace(/_/g, " ")})</p>
                        <p className="font-semibold text-foreground tabular-money">
                          {formatZarCents(job.contractValueCents)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Opening cash allocation</p>
                        <p className="font-semibold text-foreground tabular-money">
                          {formatZarCents(job.openingCashAllocationCents)}
                        </p>
                      </div>
                    </>
                  )}
                </div>
                {job.workRequirements && (
                  <p className="text-xs text-muted-foreground">{job.workRequirements}</p>
                )}
                <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                  <span>Revision {job.revision}</span>
                  {canManage && (
                    <Button variant="outline" size="sm" onClick={() => openEdit(job)} className="touch-target gap-1.5">
                      <Pencil className="h-3.5 w-3.5" />
                      {en.common.edit}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingJob ? en.jobs.editJob : en.jobs.newJob}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMutation.mutate();
            }}
            className="space-y-3"
          >
            <div className="space-y-1">
              <Label htmlFor="job-name">Job name</Label>
              <Input id="job-name" value={name} onChange={(e) => setName(e.target.value)} className="touch-target" required />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="job-customer">Customer</Label>
                <Input id="job-customer" value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="touch-target" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="job-ref">Contract reference</Label>
                <Input id="job-ref" value={contractReference} onChange={(e) => setContractReference(e.target.value)} className="touch-target" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="job-road">Road or area</Label>
              <Input id="job-road" value={roadOrArea} onChange={(e) => setRoadOrArea(e.target.value)} className="touch-target" required />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="job-value">Contract value (ZAR)</Label>
                <Input id="job-value" inputMode="decimal" value={contractValueRand} onChange={(e) => setContractValueRand(e.target.value)} className="touch-target tabular-money" />
              </div>
              <div className="space-y-1">
                <Label>VAT basis</Label>
                <Select value={vatBasis} onValueChange={(v) => setVatBasis(v as VatBasis)}>
                  <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VAT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Lifecycle status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as JobStatus)}>
                  <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {JOB_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="job-cash">Opening cash allocation (ZAR)</Label>
                <Input id="job-cash" inputMode="decimal" value={openingCashRand} onChange={(e) => setOpeningCashRand(e.target.value)} className="touch-target tabular-money" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="job-start">Planned start</Label>
                <Input id="job-start" type="date" value={plannedStartDate} onChange={(e) => setPlannedStartDate(e.target.value)} className="touch-target" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="job-end">Planned end</Label>
                <Input id="job-end" type="date" value={plannedEndDate} onChange={(e) => setPlannedEndDate(e.target.value)} className="touch-target" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="job-req">Work requirements</Label>
              <Textarea id="job-req" value={workRequirements} onChange={(e) => setWorkRequirements(e.target.value)} rows={3} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} className="touch-target">
                {en.common.cancel}
              </Button>
              <Button type="submit" disabled={saveMutation.isPending} className="touch-target">
                {en.common.save}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}