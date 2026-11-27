import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { calculateAssessmentSizing } from "@/lib/domain/assessment-calc";
import type { BudgetLineInput, RoutePoint, SiteAssessment } from "@/lib/domain/assessment-types";
import {
  calculateRouteMetrics,
  extractStartEndGps,
  formatDistanceMeters,
  hydrateRoutePoints,
} from "@/lib/domain/route-geometry";
import { formatDateSA, formatZarCents, parseZarToCents } from "@/lib/format";
import { RouteCapturePanel } from "@/components/RouteCapturePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface AssessmentReviewPanelProps {
  assessment: SiteAssessment;
  canApprove: boolean;
  onUpdatePlanning: (updated: SiteAssessment) => Promise<void>;
  onReturn: (comment: string) => Promise<void>;
  onApprove: (updated: SiteAssessment, reason: string) => Promise<void>;
  onEditScope: () => void;
  onClose: () => void;
}

export function AssessmentReviewPanel({
  assessment,
  canApprove,
  onUpdatePlanning,
  onReturn,
  onApprove,
  onEditScope,
  onClose,
}: AssessmentReviewPanelProps) {
  const { session } = useWorkTrackAuth();
  const [productivity, setProductivity] = React.useState(String(assessment.benchmarkProductivitySqm));
  const [crewSize, setCrewSize] = React.useState(String(assessment.productiveCrewSize));
  const [dailyRateRand, setDailyRateRand] = React.useState((assessment.roadWorkerDailyRateCents / 100).toFixed(2));
  const [cookRateRand, setCookRateRand] = React.useState((assessment.cookWeeklyRateCents / 100).toFixed(2));
  const [contractRand, setContractRand] = React.useState((assessment.contractValueCents / 100).toFixed(2));
  const [budgetLines, setBudgetLines] = React.useState<BudgetLineInput[]>(assessment.budgetLines);
  const [routePoints, setRoutePoints] = React.useState<RoutePoint[]>(() =>
    hydrateRoutePoints(
      assessment.routePoints,
      assessment.startGps,
      assessment.endGps,
      assessment.createdByEmail,
    ),
  );
  const [sections, setSections] = React.useState(assessment.sections);
  const [acceptedDistanceMeters, setAcceptedDistanceMeters] = React.useState(
    assessment.acceptedDistanceMeters,
  );
  const [distanceOverrideReason, setDistanceOverrideReason] = React.useState(
    assessment.distanceOverrideReason ?? "",
  );
  const [overrideKmInput, setOverrideKmInput] = React.useState(
    (assessment.acceptedDistanceMeters / 1000).toFixed(3),
  );

  const [newLineCat, setNewLineCat] = React.useState<BudgetLineInput["category"]>("fuel");
  const [newLineLabel, setNewLineLabel] = React.useState("");
  const [newLineRand, setNewLineRand] = React.useState("");
  const [newLineClass, setNewLineClass] = React.useState<"operating" | "capital">("operating");

  const [returnComment, setReturnComment] = React.useState("");
  const [approvalReason, setApprovalReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setRoutePoints(
      hydrateRoutePoints(
        assessment.routePoints,
        assessment.startGps,
        assessment.endGps,
        assessment.createdByEmail,
      ),
    );
    setSections(assessment.sections);
    setAcceptedDistanceMeters(assessment.acceptedDistanceMeters);
    setDistanceOverrideReason(assessment.distanceOverrideReason ?? "");
    setOverrideKmInput((assessment.acceptedDistanceMeters / 1000).toFixed(3));
  }, [assessment]);

  const routeMetrics = React.useMemo(() => calculateRouteMetrics(routePoints), [routePoints]);
  const waypointMeasuredMeters =
    routePoints.length >= 2 ? routeMetrics.totalDistanceMeters : assessment.waypointMeasuredDistanceMeters ?? null;

  const handleReviewRouteChange = (nextPoints: RoutePoint[]) => {
    setRoutePoints(nextPoints);
    const nextMetrics = calculateRouteMetrics(nextPoints);
    if (nextPoints.length >= 2 && nextMetrics.totalDistanceMeters > 0) {
      setAcceptedDistanceMeters(nextMetrics.totalDistanceMeters);
      setOverrideKmInput((nextMetrics.totalDistanceMeters / 1000).toFixed(3));
      if (sections.length === 1) {
        setSections([
          {
            ...sections[0]!,
            startChainageMeters: 0,
            endChainageMeters: nextMetrics.totalDistanceMeters,
          },
        ]);
      }
    }
  };

  const applyManualDistanceOverride = () => {
    const meters = Number(overrideKmInput) * 1000;
    if (!Number.isFinite(meters) || meters <= 0) {
      toast.error("Enter a positive contractual distance in kilometres.");
      return;
    }
    if (!distanceOverrideReason.trim()) {
      toast.error("Provide a reason for the contractual distance override.");
      return;
    }
    setAcceptedDistanceMeters(meters);
    if (sections.length === 1) {
      setSections([{ ...sections[0]!, startChainageMeters: 0, endChainageMeters: meters }]);
    }
    toast.success("Contractual distance override applied to sizing calculations.");
  };

  const dailyCents = parseZarToCents(dailyRateRand) ?? 0;
  const cookCents = parseZarToCents(cookRateRand) ?? 0;
  const contractCents = parseZarToCents(contractRand) ?? 0;
  const prodNum = Number(productivity) || 0;
  const crewNum = Math.max(1, Number(crewSize) || 1);

  const sizing = calculateAssessmentSizing({
    sections,
    benchmarkProductivitySqm: prodNum,
    productiveCrewSize: crewNum,
    roadWorkerDailyRateCents: dailyCents,
    cookWeeklyRateCents: cookCents,
    includeCook: assessment.includeCook,
    workdaysPerWeek: assessment.workdaysPerWeek,
    contractValueCents: contractCents,
    budgetLines,
  });

  const buildDraft = (): SiteAssessment => {
    const { startGps, endGps } = extractStartEndGps(routePoints);
    return {
      ...assessment,
      startGps: routePoints.length > 0 ? startGps : assessment.startGps,
      endGps: routePoints.length > 0 ? endGps : assessment.endGps,
      routePoints,
      waypointMeasuredDistanceMeters: waypointMeasuredMeters,
      acceptedDistanceMeters,
      distanceOverrideReason: distanceOverrideReason.trim() || null,
      sections,
      benchmarkProductivitySqm: prodNum,
      productiveCrewSize: crewNum,
      roadWorkerDailyRateCents: dailyCents,
      cookWeeklyRateCents: cookCents,
      contractValueCents: contractCents,
      budgetLines,
    };
  };

  const addBudgetLine = () => {
    const cents = parseZarToCents(newLineRand);
    if (!newLineLabel.trim() || cents === null || cents <= 0) {
      toast.error("Enter a budget description and positive ZAR amount.");
      return;
    }
    setBudgetLines((prev) => [
      ...prev,
      { id: `bl-${Date.now()}`, category: newLineCat, label: newLineLabel.trim(), amountCents: cents, classification: newLineClass },
    ]);
    setNewLineLabel("");
    setNewLineRand("");
  };

  const isApproved = assessment.status === "approved";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold">{assessment.name}</h2>
            <Badge variant="outline" className="capitalize">{assessment.status}</Badge>
            <Badge variant="secondary">Rev {assessment.revision}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {assessment.roadOrArea} · Source: {assessment.distanceSource.replace(/_/g, " ")}
            {assessment.distanceProvisional ? " (Provisional)" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onEditScope} className="touch-target">
            {isApproved ? "Amend scope" : "Edit scope wizard"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="touch-target">Back to list</Button>
        </div>
      </div>

      {assessment.benchmarkConfidence === "illustrative_assumption" && (
        <div className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn-bg p-3 text-xs text-status-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Using illustrative planning assumption ({prodNum} m²/worker-day). Labelled as estimated planning assumption — not verified historical actuals.
          </span>
        </div>
      )}

      {/* Sizing & unit economics summary */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>Road / Verge length</CardDescription>
            <CardTitle className="text-xl tabular-money">
              {(sizing.roadLengthMeters / 1000).toFixed(2)} / {(sizing.vergeLengthMeters / 1000).toFixed(2)} km
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Area: {sizing.physicalAreaSqm.toLocaleString()} m²
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>Effort units</CardDescription>
            <CardTitle className="text-xl tabular-money">{sizing.effortUnitsSqm.toLocaleString()} m²</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Factor: {sizing.weightedDifficultyFactor}× · {sizing.requiredWorkerDays ?? "—"} worker-days
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>Planned crew duration</CardDescription>
            <CardTitle className="text-xl tabular-money">
              {sizing.plannedCrewDays ?? "—"} days ({sizing.plannedWeeks ?? "—"} wks)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Labour est.: {formatZarCents(sizing.estimatedLabourCents)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>Est. operating surplus</CardDescription>
            <CardTitle className="text-xl tabular-money">{formatZarCents(sizing.estimatedOperatingSurplusCents)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            OpEx: {formatZarCents(sizing.estimatedTotalOperatingCents)} · CapEx: {formatZarCents(sizing.estimatedCapitalCents)}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-4 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
        <span>Cost / road km: <strong className="text-foreground tabular-money">{sizing.costPerRoadKmCents !== null ? formatZarCents(sizing.costPerRoadKmCents) : "—"}</strong></span>
        <span>Cost / verge km: <strong className="text-foreground tabular-money">{sizing.costPerVergeKmCents !== null ? formatZarCents(sizing.costPerVergeKmCents) : "—"}</strong></span>
        <span>Cost / m²: <strong className="text-foreground tabular-money">{sizing.costPerSqmCents !== null ? formatZarCents(sizing.costPerSqmCents) : "—"}</strong></span>
        <span>Excludes tax & loan repayments</span>
      </div>

      {/* Interactive GPS Route Map & Distance Reconciliation */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Measured GPS route & distance baseline</CardTitle>
          <CardDescription className="text-xs">
            {canApprove
              ? isApproved
                ? "Approved baseline route. Any waypoint edits require approving a new Scope Amendment Revision below."
                : "Add, drag, insert, reorder, or delete waypoints to refine the route. Dependent sizing updates immediately."
              : "Captured GPS waypoints and segment distances from start."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded border border-border bg-muted/40 p-2.5">
              <p className="text-muted-foreground">Waypoint-measured distance</p>
              <p className="text-sm font-bold tabular-money">
                {waypointMeasuredMeters !== null ? formatDistanceMeters(waypointMeasuredMeters) : "Not captured"}
              </p>
            </div>
            <div className="rounded border border-border bg-muted/40 p-2.5">
              <p className="text-muted-foreground">Road-network distance (separate)</p>
              <p className="text-sm font-bold tabular-money">
                {assessment.roadNetworkDistanceMeters !== null && assessment.roadNetworkDistanceMeters !== undefined
                  ? formatDistanceMeters(assessment.roadNetworkDistanceMeters)
                  : "Not provided"}
              </p>
            </div>
            <div className="rounded border border-border bg-muted/40 p-2.5">
              <p className="text-muted-foreground">Approved / accepted basis</p>
              <p className="text-sm font-bold tabular-money">
                {formatDistanceMeters(acceptedDistanceMeters)}
              </p>
            </div>
          </div>

          <RouteCapturePanel
            points={routePoints}
            editable={canApprove}
            userEmail={session?.email ?? ""}
            userId={session?.userId ?? null}
            gpsUnavailableReason={assessment.gpsUnavailableReason ?? ""}
            onChangePoints={handleReviewRouteChange}
            onGpsUnavailable={() => {}}
          />

          {canApprove && (
            <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3 sm:grid-cols-4">
              <div>
                <Label className="text-xs">Contractual override (km)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={overrideKmInput}
                  onChange={(e) => setOverrideKmInput(e.target.value)}
                  className="touch-target tabular-money"
                />
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">Override reason (required)</Label>
                <Input
                  value={distanceOverrideReason}
                  onChange={(e) => setDistanceOverrideReason(e.target.value)}
                  placeholder="e.g. Agreed municipal chainage certificate"
                  className="touch-target"
                />
              </div>
              <div className="flex items-end">
                <Button type="button" variant="outline" onClick={applyManualDistanceOverride} className="touch-target w-full">
                  Apply override
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Planning assumptions & budget lines (Admin editable) */}
      {canApprove && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sizing & budget assumptions</CardTitle>
            <CardDescription>Adjust productivity, crew size, contract revenue, and operating/capital lines before approval.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-5">
              <div>
                <Label className="text-xs">m² / worker-day</Label>
                <Input type="number" min="1" value={productivity} onChange={(e) => setProductivity(e.target.value)} className="touch-target tabular-money" />
              </div>
              <div>
                <Label className="text-xs">Crew size</Label>
                <Input type="number" min="1" value={crewSize} onChange={(e) => setCrewSize(e.target.value)} className="touch-target tabular-money" />
              </div>
              <div>
                <Label className="text-xs">Worker / day (R)</Label>
                <Input inputMode="decimal" value={dailyRateRand} onChange={(e) => setDailyRateRand(e.target.value)} className="touch-target tabular-money" />
              </div>
              <div>
                <Label className="text-xs">Cook / wk (R)</Label>
                <Input inputMode="decimal" value={cookRateRand} onChange={(e) => setCookRateRand(e.target.value)} className="touch-target tabular-money" />
              </div>
              <div>
                <Label className="text-xs">Contract value (R)</Label>
                <Input inputMode="decimal" value={contractRand} onChange={(e) => setContractRand(e.target.value)} className="touch-target tabular-money" />
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Other budget lines</p>
              {budgetLines.map((line) => (
                <div key={line.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2 text-xs">
                  <span>
                    <strong className="capitalize">{line.category.replace(/_/g, " ")}</strong> — {line.label}{" "}
                    <Badge variant="outline" className="ml-1">{line.classification}</Badge>
                  </span>
                  <span className="flex items-center gap-2 font-semibold tabular-money">
                    {formatZarCents(line.amountCents)}
                    <button type="button" onClick={() => setBudgetLines((p) => p.filter((x) => x.id !== line.id))} aria-label="Remove line">
                      <Trash2 className="h-3.5 w-3.5 text-status-danger" />
                    </button>
                  </span>
                </div>
              ))}
              <div className="grid gap-2 pt-1 sm:grid-cols-5">
                <Select value={newLineCat} onValueChange={(v) => setNewLineCat(v as BudgetLineInput["category"])}>
                  <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["fuel", "food", "rent", "equipment_hire", "maintenance", "transport", "safety", "disposal", "admin", "contingency"].map((c) => (
                      <SelectItem key={c} value={c}>{c.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input placeholder="Description" value={newLineLabel} onChange={(e) => setNewLineLabel(e.target.value)} className="touch-target sm:col-span-2" />
                <Input placeholder="Amount (R)" inputMode="decimal" value={newLineRand} onChange={(e) => setNewLineRand(e.target.value)} className="touch-target tabular-money" />
                <div className="flex gap-1.5">
                  <Select value={newLineClass} onValueChange={(v) => setNewLineClass(v as "operating" | "capital")}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="operating">OpEx</SelectItem>
                      <SelectItem value="capital">CapEx</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" size="icon" onClick={addBudgetLine} className="touch-target shrink-0" aria-label="Add budget line">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onUpdatePlanning(buildDraft());
                  } finally {
                    setBusy(false);
                  }
                }}
                className="touch-target"
              >
                Save planning numbers
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Admin Approval / Return / Scope Amendment controls */}
      {canApprove && (
        <div className="grid gap-4 md:grid-cols-2">
          {!isApproved && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Return to owner</CardTitle>
                <CardDescription className="text-xs">Ask for missing widths, distance confirmation, or corrections.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea placeholder="Explain what needs to be checked..." value={returnComment} onChange={(e) => setReturnComment(e.target.value)} rows={2} />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onReturn(returnComment);
                      setReturnComment("");
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="touch-target gap-1.5"
                >
                  <RotateCcw className="h-4 w-4" />
                  Return assessment
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className={isApproved ? "md:col-span-2" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {isApproved ? "Approve scope amendment (new revision)" : "Approve baseline scope & create planned job"}
              </CardTitle>
              <CardDescription className="text-xs">
                {isApproved
                  ? "Preserves Revision 1 baseline and records a new immutable scope revision (T24)."
                  : "Locks Revision 1 baseline snapshot and creates a linked Planned Job."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder={isApproved ? "Mandatory reason for scope amendment..." : "Approval note (optional)"}
                value={approvalReason}
                onChange={(e) => setApprovalReason(e.target.value)}
                className="touch-target"
              />
              <Button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onApprove(buildDraft(), approvalReason);
                    setApprovalReason("");
                  } finally {
                    setBusy(false);
                  }
                }}
                className="touch-target gap-1.5"
              >
                <CheckCircle2 className="h-4 w-4" />
                {isApproved ? `Approve Revision ${assessment.revisions.length + 1}` : "Approve baseline (Rev 1)"}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Immutable Baseline & Amendment History (T24) */}
      {assessment.revisions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" />
              Immutable scope revision history
            </CardTitle>
            <CardDescription className="text-xs">Baseline Revision 1 is preserved alongside all subsequent amendments.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {assessment.revisions.map((rev) => (
              <div key={rev.revision} className="rounded-md border border-border p-3 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    Revision {rev.revision} {rev.revision === 1 ? "(Original Baseline)" : "(Amendment)"}
                  </span>
                  <span className="text-muted-foreground">
                    Approved {formatDateSA(rev.approvedAt)} by {rev.approvedByEmail}
                  </span>
                </div>
                <p className="text-muted-foreground">Reason: {rev.reason}</p>
                <p className="tabular-money">
                  Road: {(rev.roadLengthMeters / 1000).toFixed(2)} km · Verge: {(rev.vergeLengthMeters / 1000).toFixed(2)} km · Area: {rev.physicalAreaSqm.toLocaleString()} m² · Effort: {rev.effortUnitsSqm.toLocaleString()} m² · OpEx: {formatZarCents(rev.estimatedOperatingCents)}
                  {rev.routePoints && rev.routePoints.length > 0 ? ` · ${rev.routePoints.length} route pts` : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}