import {useOfflineSync} from "@/lib/offline/sync-context";
import {enqueueOfflineMutation} from "@/lib/offline/sync-engine";
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, format, parseISO } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudRain,
  Crosshair,
  HardHat,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs } from "@/lib/data/repository";
import { listAssessmentsAndBenchmarks } from "@/lib/data/assessment-repository";
import {
  createInterruption,
  createProgressEntries,
  getDefaultScopeForJob,
  listJobProgressBundle,
  verifyProgressEntry,
} from "@/lib/data/increment-c-repository";
import {
  SCOPE_ACTIVITY_LABELS,
  type ScopeActivity,
  type VergeSide,
} from "@/lib/domain/assessment-types";
import {
  INTERRUPTION_REASON_LABELS,
  type InterruptionReason,
  type ProgressSource,
  type ProgressStageStatus,
} from "@/lib/domain/increment-c-types";
import { calculateJobProgress } from "@/lib/domain/progress-calc";
import { projectPointOntoRoute } from "@/lib/domain/route-geometry";
import { formatDateSA, getMonSunWeekRange, todaySAST } from "@/lib/format";
import { can } from "@/lib/permissions";
import { en } from "@/i18n/en";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/work")({
  head: () => ({
    meta: [
      { title: "Work progress — WorkTrack" },
      {
        name: "description",
        content: "Daily work progress by chainage/verge/activity and job interruptions.",
      },
      { property: "og:title", content: "Work progress — WorkTrack" },
      {
        property: "og:description",
        content: "Daily work progress by chainage/verge/activity and job interruptions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WorkProgressPage,
});

const VERGE_LABELS: Record<VergeSide, string> = {
  left: "Left verge",
  right: "Right verge",
  outer_a: "Outer A",
  inner_a: "Inner A",
  inner_b: "Inner B",
  outer_b: "Outer B",
  shared_median: "Shared median",
};

function WorkProgressPage() {
  const { session } = useWorkTrackAuth();
  const qc = useQueryClient();
  const {effectiveOnline,refreshOfflineState}=useOfflineSync();
  const initialWeek = useMemo(() => getMonSunWeekRange(todaySAST()), []);
  const [weekStart, setWeekStart] = useState(initialWeek.start);
  const weekRange = useMemo(() => getMonSunWeekRange(weekStart), [weekStart]);

  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });
  const assessmentsQuery = useQuery({
    queryKey: ["assessments", session?.businessId],
    queryFn: () => listAssessmentsAndBenchmarks(session!),
    enabled: Boolean(session),
  });

  const jobs = jobsQuery.data ?? [];
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const activeJobId = selectedJobId || jobs[0]?.id || "";

  const progressQuery = useQuery({
    queryKey: ["work-progress", session?.businessId, activeJobId],
    queryFn: () => listJobProgressBundle(session!, activeJobId),
    enabled: Boolean(session && activeJobId),
  });

  const linkedAssessment = useMemo(
    () =>
      (assessmentsQuery.data?.assessments ?? []).find(
        (a) => a.jobId === activeJobId && a.status === "approved",
      ) ?? null,
    [assessmentsQuery.data, activeJobId],
  );

  const scopeSections = useMemo(
    () =>
      linkedAssessment && linkedAssessment.sections.length > 0
        ? linkedAssessment.sections
        : activeJobId
          ? getDefaultScopeForJob(activeJobId)
          : [],
    [linkedAssessment, activeJobId],
  );

  const [sectionId, setSectionId] = useState("");
  const activeSection =
    scopeSections.find((s) => s.id === sectionId) ?? scopeSections[0];

  const [selectedSides, setSelectedSides] = useState<VergeSide[]>(["left"]);
  const [activity, setActivity] = useState<ScopeActivity>("cutting");
  const [reportedDate, setReportedDate] = useState(todaySAST());
  const [startChainage, setStartChainage] = useState("0");
  const [endChainage, setEndChainage] = useState("500");
  const [stageStatus, setStageStatus] = useState<ProgressStageStatus>("complete");
  const [isRework, setIsRework] = useState(false);
  const [source, setSource] = useState<ProgressSource>("manual");
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [photoDate, setPhotoDate] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");

  // Interruption form state
  const [intDate, setIntDate] = useState(todaySAST());
  const [intFullDay, setIntFullDay] = useState(false);
  const [intHours, setIntHours] = useState("3");
  const [intAffected, setIntAffected] = useState("Full clearing crew");
  const [intReason, setIntReason] = useState<InterruptionReason>("rain");
  const [intComment, setIntComment] = useState("");

  const entries = progressQuery.data?.entries ?? [];
  const interruptions = progressQuery.data?.interruptions ?? [];

  const summary = useMemo(
    () => calculateJobProgress(scopeSections, entries, weekRange),
    [scopeSections, entries, weekRange],
  );

  const saveProgressMutation = useMutation({
    mutationFn: async () => {
      if (!session || !activeJobId || !activeSection) {
        throw new Error("Select a job and approved road section first.");
      }
      const startM = Number(startChainage);
      const endM = Number(endChainage);
      const input = {
        jobId: activeJobId,
        section: activeSection,
        vergeSides: selectedSides,
        activity,
        reportedDate,
        startChainageMeters: startM,
        endChainageMeters: endM,
        stageStatus,
        isRework,
        source,
        gpsAccuracyMeters: gpsAccuracy,
        photoDate: photoDate || null,
        evidenceNote,
      };
      if(!effectiveOnline){if(!Number.isFinite(startM)||!Number.isFinite(endM)||startM<0||endM<=startM||selectedSides.length===0)throw new Error('Enter a valid completed range and verge strips.');await enqueueOfflineMutation(session,{entityType:'progress_entry',operation:'create',label:`Work progress ${reportedDate}`,payload:{kind:'progress',input}});await refreshOfflineState();return {queued:true,created:[]};}
      return {queued:false,created:await createProgressEntries(session,input)};
    },
    onSuccess: (result) => {
      const created=result.created;
      if(result.queued){toast.info("Saved on phone — awaiting sync.");return;}
      qc.invalidateQueries({ queryKey: ["work-progress", session?.businessId, activeJobId] });
      const flagged = created.some((c) => c.verificationState === "flagged_conflict");
      toast.success(
        flagged
          ? `Saved ${created.length} entry(s) and flagged for scope review.`
          : `Saved ${created.length} work progress entry(s).`,
      );
      setEvidenceNote("");
      setSource("manual");
      setGpsAccuracy(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const verifyMutation = useMutation({
    mutationFn: (entryId: string) => verifyProgressEntry(session!, entryId, "verified"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-progress", session?.businessId, activeJobId] });
      toast.success("Progress entry marked verified.");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const saveInterruptionMutation = useMutation({
    mutationFn: async () => {
      if (!session || !activeJobId) throw new Error("Select a job first.");
      const duration = intFullDay ? 9 : Number(intHours);
      if (!Number.isFinite(duration) || duration < 0 || duration > 24) {
        throw new Error("Duration hours must be between 0 and 24.");
      }
      const input = {
        jobId: activeJobId,
        interruptionDate: intDate,
        durationHours: duration,
        fullDay: intFullDay,
        affectedCrewOrSection: intAffected,
        reason: intReason,
        comment: intComment,
      };
      if (!effectiveOnline) {
        await enqueueOfflineMutation(session, {
          entityType: "interruption",
          operation: "create",
          label: `Interruption (${INTERRUPTION_REASON_LABELS[intReason]}) ${intDate}`,
          payload: { kind: "interruption", input },
        });
        await refreshOfflineState();
        return { queued: true };
      }
      await createInterruption(session, input);
      return { queued: false };
    },
    onSuccess: (res) => {
      if (res.queued) {
        toast.info("Interruption saved on phone — awaiting sync.");
      } else {
        qc.invalidateQueries({ queryKey: ["work-progress", session?.businessId, activeJobId] });
        toast.success("Interruption logged.");
      }
      setIntComment("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleSnapGps = (target: "start" | "end") => {
    const pts = linkedAssessment?.routePoints ?? [];
    if (pts.length < 2) {
      toast.error("No approved multi-waypoint route on this job yet — enter chainage manually.");
      return;
    }
    if (!navigator.geolocation) {
      toast.error("GPS unavailable on this device — enter chainage manually.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const proj = projectPointOntoRoute(pts, pos.coords.latitude, pos.coords.longitude);
        if (!proj) {
          toast.error("Could not project GPS onto route.");
          return;
        }
        const snapped = Math.round(proj.distanceFromStartMeters);
        if (target === "start") setStartChainage(String(snapped));
        else setEndChainage(String(snapped));
        setSource("gps_snapped");
        setGpsAccuracy(Math.round(pos.coords.accuracy));
        toast.success(
          `Snapped ${target} to ${snapped}m (offset ${Math.round(proj.offsetMeters)}m, GPS ±${Math.round(pos.coords.accuracy)}m). Confirm before saving.`,
        );
      },
      () => toast.error("Location permission denied — enter chainage manually."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const toggleSide = (side: VergeSide) => {
    setSelectedSides((prev) =>
      prev.includes(side) ? prev.filter((s) => s !== side) : [...prev, side],
    );
  };

  const shiftWeek = (deltaDays: number) => {
    setWeekStart(format(addDays(parseISO(weekStart), deltaDays), "yyyy-MM-dd"));
  };

  if (!session) return null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{en.work.title}</h1>
          <p className="text-sm text-muted-foreground">{en.work.subtitle}</p>
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Physical progress</CardDescription>
            <CardTitle className="text-2xl tabular-money">
              {summary.physicalPercent.toFixed(1)}%
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {Math.round(summary.fullyCompletedPhysicalAreaSqm).toLocaleString()} /{" "}
            {Math.round(summary.approvedPhysicalAreaSqm).toLocaleString()} m² fully done
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Effort-weighted progress</CardDescription>
            <CardTitle className="text-2xl tabular-money">
              {summary.effortWeightedPercent.toFixed(1)}%
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {Math.round(summary.fullyCompletedWeightedAreaSqm).toLocaleString()} /{" "}
            {Math.round(summary.approvedWeightedAreaSqm).toLocaleString()} weighted m²
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>This week (incremental)</CardDescription>
            <CardTitle className="text-2xl tabular-money">
              {Math.round(summary.weeklyIncrementalMeters).toLocaleString()} m
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {Math.round(summary.weeklyIncrementalPhysicalAreaSqm).toLocaleString()} m² ·{" "}
            {summary.reworkEntryCount} rework ({Math.round(summary.reworkMeters)}m excluded)
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Forecast remaining</CardDescription>
            <CardTitle className="text-2xl tabular-money">
              {summary.estimatedWeeksRemaining != null
                ? `${summary.estimatedWeeksRemaining.toFixed(1)} wks`
                : "Pending"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {summary.insufficientHistory
              ? en.work.insufficientHistory
              : `Based on ${summary.productiveWeeksObserved} productive week(s)`}
          </CardContent>
        </Card>
      </div>

      {summary.flaggedConflictCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-status-warn/40 bg-status-warn-bg p-3 text-sm text-status-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {summary.flaggedConflictCount} progress entry(s) flagged as out-of-scope or conflicting
            and excluded from completed totals until reviewed.
          </span>
        </div>
      )}

      <Tabs defaultValue="progress" className="space-y-4">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="progress" className="touch-target gap-2">
            <HardHat className="h-4 w-4" />
            {en.work.tabProgress}
          </TabsTrigger>
          <TabsTrigger value="interruptions" className="touch-target gap-2">
            <CloudRain className="h-4 w-4" />
            {en.work.tabInterruptions} ({interruptions.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="progress" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{en.work.logProgress}</CardTitle>
              <CardDescription>
                Select one or more verge strips — multi-verge entries expand into separate strip
                records. Overlapping intervals are merged automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="prog-date">Reported date</Label>
                  <Input id="prog-date" type="date" value={reportedDate} onChange={(e) => setReportedDate(e.target.value)} className="h-11" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prog-section">Approved section</Label>
                  <select
                    id="prog-section"
                    value={activeSection?.id ?? ""}
                    onChange={(e) => setSectionId(e.target.value)}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {scopeSections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label} ({s.startChainageMeters}m–{s.endChainageMeters}m)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prog-activity">Activity</Label>
                  <select
                    id="prog-activity"
                    value={activity}
                    onChange={(e) => setActivity(e.target.value as ScopeActivity)}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {(Object.keys(SCOPE_ACTIVITY_LABELS) as ScopeActivity[]).map((k) => (
                      <option key={k} value={k}>
                        {SCOPE_ACTIVITY_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Verge strip(s) worked</Label>
                <div className="flex flex-wrap gap-2">
                  {(activeSection?.strips ?? []).map((st) => {
                    const checked = selectedSides.includes(st.side);
                    return (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => toggleSide(st.side)}
                        className={`touch-target rounded-md border px-3 text-sm font-medium transition-colors ${
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-card text-foreground hover:bg-muted"
                        }`}
                      >
                        {VERGE_LABELS[st.side]} ({st.widthMeters ?? "?"}m)
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-4">
                <div className="space-y-1.5">
                  <Label htmlFor="prog-start">Start chainage (m)</Label>
                  <Input id="prog-start" type="number" min={0} value={startChainage} onChange={(e) => setStartChainage(e.target.value)} className="h-11" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prog-end">End chainage (m)</Label>
                  <Input id="prog-end" type="number" min={1} value={endChainage} onChange={(e) => setEndChainage(e.target.value)} className="h-11" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prog-stage">Stage status</Label>
                  <select
                    id="prog-stage"
                    value={stageStatus}
                    onChange={(e) => setStageStatus(e.target.value as ProgressStageStatus)}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="complete">Complete</option>
                    <option value="partial">Partial</option>
                    <option value="in_progress">In progress</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prog-photo-date">Photo date (optional)</Label>
                  <Input id="prog-photo-date" type="date" value={photoDate} onChange={(e) => setPhotoDate(e.target.value)} className="h-11" />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" className="touch-target gap-2" onClick={() => handleSnapGps("start")}>
                  <Crosshair className="h-4 w-4" />
                  Snap GPS start
                </Button>
                <Button type="button" variant="outline" className="touch-target gap-2" onClick={() => handleSnapGps("end")}>
                  <Crosshair className="h-4 w-4" />
                  Snap GPS end
                </Button>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={isRework} onChange={(e) => setIsRework(e.target.checked)} className="h-4 w-4" />
                  <RefreshCw className="h-4 w-4 text-status-warn" />
                  {en.work.reworkLabel}
                </label>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="prog-note">Evidence / field note</Label>
                <Input id="prog-note" value={evidenceNote} onChange={(e) => setEvidenceNote(e.target.value)} placeholder="e.g. Cleared thick grass and bagged litter" className="h-11" />
              </div>

              <Button
                type="button"
                className="touch-target"
                disabled={saveProgressMutation.isPending}
                onClick={() => saveProgressMutation.mutate()}
              >
                {saveProgressMutation.isPending ? "Saving..." : en.work.logProgress}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Strip &amp; activity overlap breakdown</CardTitle>
              <CardDescription>
                A strip interval counts as fully completed only where all required activities overlap as complete.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {summary.strips.map((st) => (
                <div key={`${st.sectionId}-${st.vergeSide}`} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      {st.sectionLabel} — {VERGE_LABELS[st.vergeSide]} ({st.widthMeters}m wide)
                    </span>
                    <Badge variant="outline" className="tabular-money">
                      Fully done: {Math.round(st.fullyCompletedMeters)}m / {Math.round(st.approvedLengthMeters)}m
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {st.activityMetrics.map((m) => (
                      <span key={m.activity} className="rounded bg-muted px-2 py-1">
                        {SCOPE_ACTIVITY_LABELS[m.activity]}: <strong>{Math.round(m.uniqueCompletedMeters)}m</strong> unique
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Recorded progress entries ({entries.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No progress entries recorded for this job yet.</p>
              ) : (
                entries.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{formatDateSA(entry.reportedDate)}</span>
                        <Badge variant="outline">{VERGE_LABELS[entry.vergeSide]}</Badge>
                        <Badge variant="secondary">{SCOPE_ACTIVITY_LABELS[entry.activity]}</Badge>
                        <span className="font-mono text-xs">
                          {entry.startChainageMeters}m – {entry.endChainageMeters}m
                        </span>
                        {entry.isRework && <Badge variant="destructive">Rework</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Stage: {entry.stageStatus} · Source: {entry.source}
                        {entry.gpsAccuracyMeters != null ? ` (GPS ±${entry.gpsAccuracyMeters}m)` : ""}
                        {entry.photoDate ? ` · Photo: ${formatDateSA(entry.photoDate)}` : ""}
                        {" · "}By {entry.submittedByEmail}
                      </p>
                      {entry.evidenceNote && <p className="text-xs">{entry.evidenceNote}</p>}
                      {entry.conflictReason && (
                        <p className="text-xs font-medium text-status-warn">{entry.conflictReason}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          entry.verificationState === "verified"
                            ? "default"
                            : entry.verificationState === "flagged_conflict"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {entry.verificationState === "verified" && <CheckCircle2 className="mr-1 h-3 w-3" />}
                        {entry.verificationState.replace("_", " ")}
                      </Badge>
                      {(can(session.role, "jobs.manage") || session.role === "owner") &&
                        entry.verificationState !== "verified" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9"
                            onClick={() => verifyMutation.mutate(entry.id)}
                          >
                            Verify
                          </Button>
                        )}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="interruptions" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{en.work.logInterruption}</CardTitle>
              <CardDescription>
                Record rain, breakdowns, fuel shortages, customer holds, or public holidays explicitly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="int-date">Date</Label>
                  <Input id="int-date" type="date" value={intDate} onChange={(e) => setIntDate(e.target.value)} className="h-11" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="int-reason">Reason</Label>
                  <select
                    id="int-reason"
                    value={intReason}
                    onChange={(e) => setIntReason(e.target.value as InterruptionReason)}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {(Object.keys(INTERRUPTION_REASON_LABELS) as InterruptionReason[]).map((k) => (
                      <option key={k} value={k}>
                        {INTERRUPTION_REASON_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="int-hours">Duration (hours)</Label>
                  <Input
                    id="int-hours"
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    disabled={intFullDay}
                    value={intFullDay ? "9" : intHours}
                    onChange={(e) => setIntHours(e.target.value)}
                    className="h-11"
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="int-affected">Affected crew or road section</Label>
                  <Input id="int-affected" value={intAffected} onChange={(e) => setIntAffected(e.target.value)} className="h-11" />
                </div>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 self-end text-sm">
                  <input type="checkbox" checked={intFullDay} onChange={(e) => setIntFullDay(e.target.checked)} className="h-4 w-4" />
                  Full workday lost
                </label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="int-comment">Comment (optional)</Label>
                <Input id="int-comment" value={intComment} onChange={(e) => setIntComment(e.target.value)} placeholder="Details of delay or breakdown" className="h-11" />
              </div>
              <Button
                type="button"
                className="touch-target"
                disabled={saveInterruptionMutation.isPending}
                onClick={() => saveInterruptionMutation.mutate()}
              >
                {saveInterruptionMutation.isPending ? "Saving..." : en.work.logInterruption}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Interruptions log ({interruptions.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {interruptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No interruptions logged for this job.</p>
              ) : (
                interruptions.map((item) => (
                  <div key={item.id} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{formatDateSA(item.interruptionDate)}</span>
                        <Badge variant="outline">{INTERRUPTION_REASON_LABELS[item.reason]}</Badge>
                      </div>
                      <span className="text-xs font-semibold tabular-money">
                        {item.fullDay ? "Full day" : `${item.durationHours}h`}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.affectedCrewOrSection || "Crew"} · Logged by {item.submittedByEmail}
                    </p>
                    {item.comment && <p className="mt-1 text-xs">{item.comment}</p>}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}