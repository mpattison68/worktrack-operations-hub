import * as React from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  MapPin,
  Plus,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  DIFFICULTY_FACTORS,
  DIFFICULTY_REASON_LABELS,
  SCOPE_ACTIVITY_LABELS,
  type CarriagewayType,
  type DifficultyLevel,
  type DifficultyReason,
  type DistanceSource,
  type GpsPoint,
  type RoadSectionInput,
  type ScopeActivity,
  type SiteAssessment,
  type VergeSide,
} from "@/lib/domain/assessment-types";
import { calculateAssessmentSizing, validateAssessmentSections } from "@/lib/domain/assessment-calc";
import { CarriagewayDiagram } from "@/components/CarriagewayDiagram";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const QUICK_WIDTHS = [1, 2, 3, 5, 10];

interface AssessmentWizardProps {
  initial?: SiteAssessment | null;
  onSave: (
    data: Omit<SiteAssessment, "id" | "businessId" | "createdAt" | "updatedAt" | "createdByEmail"> & {
      id?: string;
    },
    submit: boolean,
  ) => Promise<void>;
  onCancel: () => void;
}

function makeDefaultSection(distanceMeters: number): RoadSectionInput {
  return {
    id: `sec-${Date.now()}`,
    label: "Section 1 (Full route)",
    startChainageMeters: 0,
    endChainageMeters: distanceMeters,
    carriageway: "single",
    strips: [
      { id: "st-l", side: "left", widthMeters: 5, lengthOverrideMeters: null },
      { id: "st-r", side: "right", widthMeters: 5, lengthOverrideMeters: null },
    ],
    difficulty: "similar",
    difficultyReasons: [],
    activities: ["cutting", "waste_collection"],
    notes: "",
  };
}

export function AssessmentWizard({ initial, onSave, onCancel }: AssessmentWizardProps) {
  const [step, setStep] = React.useState(1);
  const [saving, setSaving] = React.useState(false);

  const [name, setName] = React.useState(initial?.name ?? "");
  const [customerName, setCustomerName] = React.useState(initial?.customerName ?? "");
  const [roadOrArea, setRoadOrArea] = React.useState(initial?.roadOrArea ?? "");
  const [direction, setDirection] = React.useState(
    initial?.directionDescription ?? "Start to End",
  );

  const [startGps, setStartGps] = React.useState<GpsPoint | null>(initial?.startGps ?? null);
  const [endGps, setEndGps] = React.useState<GpsPoint | null>(initial?.endGps ?? null);
  const [gpsUnavailableReason, setGpsUnavailableReason] = React.useState(
    initial?.gpsUnavailableReason ?? "",
  );
  const [distanceSource, setDistanceSource] = React.useState<DistanceSource>(
    initial?.distanceSource ?? "manual_distance",
  );
  const [distanceKm, setDistanceKm] = React.useState(
    initial ? String(initial.acceptedDistanceMeters / 1000) : "10",
  );
  const [distanceOverrideReason, setDistanceOverrideReason] = React.useState(
    initial?.distanceOverrideReason ?? "",
  );
  const [distanceProvisional, setDistanceProvisional] = React.useState(
    initial?.distanceProvisional ?? false,
  );

  const [sections, setSections] = React.useState<RoadSectionInput[]>(
    initial?.sections.length ? initial.sections : [makeDefaultSection(10000)],
  );
  const [exclusions, setExclusions] = React.useState(initial?.exclusions ?? "");

  const acceptedDistanceMeters = Math.max(0, Math.round((Number(distanceKm) || 0) * 1000));

  // Keep single-section quick path synced to accepted distance
  React.useEffect(() => {
    if (sections.length === 1 && acceptedDistanceMeters > 0) {
      setSections((prev) => {
        const first = prev[0];
        if (!first || first.endChainageMeters === acceptedDistanceMeters) return prev;
        return [{ ...first, startChainageMeters: 0, endChainageMeters: acceptedDistanceMeters }];
      });
    }
  }, [acceptedDistanceMeters, sections.length]);

  const captureGps = (target: "start" | "end") => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGpsUnavailableReason("Browser geolocation unavailable — manual distance used.");
      toast.info("GPS unavailable. Enter road distance manually.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point: GpsPoint = {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
          accuracyMeters: Math.round(pos.coords.accuracy),
          capturedAt: new Date().toISOString(),
        };
        if (target === "start") setStartGps(point);
        else setEndGps(point);
        toast.success(`GPS ${target} point captured (±${point.accuracyMeters}m).`);
      },
      () => {
        setGpsUnavailableReason("GPS permission denied or signal unavailable — manual distance used.");
        toast.info("GPS denied/unavailable. Continue using manual chainage or manual distance.");
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const updateSection = (idx: number, patch: Partial<RoadSectionInput>) => {
    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const toggleStripSide = (secIdx: number, side: VergeSide) => {
    setSections((prev) =>
      prev.map((sec, i) => {
        if (i !== secIdx) return sec;
        const exists = sec.strips.some((st) => st.side === side);
        if (exists) {
          return { ...sec, strips: sec.strips.filter((st) => st.side !== side) };
        }
        // Shared median cannot coexist with inner_a or inner_b (T02 guard)
        let filtered = sec.strips;
        if (side === "shared_median") {
          filtered = sec.strips.filter((st) => st.side !== "inner_a" && st.side !== "inner_b");
        } else if (side === "inner_a" || side === "inner_b") {
          filtered = sec.strips.filter((st) => st.side !== "shared_median");
        }
        return {
          ...sec,
          strips: [
            ...filtered,
            { id: `st-${side}-${Date.now()}`, side, widthMeters: 5, lengthOverrideMeters: null },
          ],
        };
      }),
    );
  };

  const setCarriageway = (secIdx: number, cw: CarriagewayType) => {
    updateSection(secIdx, {
      carriageway: cw,
      strips:
        cw === "single"
          ? [
              { id: `st-l-${Date.now()}`, side: "left", widthMeters: 5, lengthOverrideMeters: null },
              { id: `st-r-${Date.now() + 1}`, side: "right", widthMeters: 5, lengthOverrideMeters: null },
            ]
          : [
              { id: `st-oa-${Date.now()}`, side: "outer_a", widthMeters: 5, lengthOverrideMeters: null },
              { id: `st-ob-${Date.now() + 1}`, side: "outer_b", widthMeters: 5, lengthOverrideMeters: null },
            ],
    });
  };

  const sizing = calculateAssessmentSizing({
    sections,
    benchmarkProductivitySqm: initial?.benchmarkProductivitySqm ?? 250,
    productiveCrewSize: initial?.productiveCrewSize ?? 12,
    roadWorkerDailyRateCents: initial?.roadWorkerDailyRateCents ?? 25000,
    cookWeeklyRateCents: initial?.cookWeeklyRateCents ?? 50000,
    includeCook: initial?.includeCook ?? true,
    workdaysPerWeek: initial?.workdaysPerWeek ?? 5,
    contractValueCents: initial?.contractValueCents ?? 0,
    budgetLines: initial?.budgetLines ?? [],
  });
  const validationErrors = validateAssessmentSections(sections);

  const handlePersist = async (submit: boolean) => {
    if (!name.trim() || !roadOrArea.trim()) {
      toast.error("Enter the job/road name and road location in Step 1.");
      setStep(1);
      return;
    }
    if (acceptedDistanceMeters <= 0) {
      toast.error("Enter a positive road distance in Step 2.");
      setStep(2);
      return;
    }
    if (validationErrors.length > 0) {
      toast.error(validationErrors[0]!);
      return;
    }
    setSaving(true);
    try {
      await onSave(
        {
          ...(initial?.id ? { id: initial.id } : {}),
          jobId: initial?.jobId ?? null,
          name,
          customerName,
          roadOrArea,
          directionDescription: direction,
          status: submit ? "submitted" : "draft",
          revision: initial?.revision ?? 1,
          startGps,
          endGps,
          gpsUnavailableReason: gpsUnavailableReason.trim() || null,
          distanceSource,
          originalDistanceMeters: initial?.originalDistanceMeters ?? acceptedDistanceMeters,
          acceptedDistanceMeters,
          distanceOverrideReason: distanceOverrideReason.trim() || null,
          distanceProvisional,
          sections,
          exclusions,
          benchmarkId: initial?.benchmarkId ?? "bm-illustrative-1",
          benchmarkProductivitySqm: initial?.benchmarkProductivitySqm ?? 250,
          benchmarkConfidence: initial?.benchmarkConfidence ?? "illustrative_assumption",
          productiveCrewSize: initial?.productiveCrewSize ?? 12,
          roadWorkerDailyRateCents: initial?.roadWorkerDailyRateCents ?? 25000,
          cookWeeklyRateCents: initial?.cookWeeklyRateCents ?? 50000,
          includeCook: initial?.includeCook ?? true,
          workdaysPerWeek: initial?.workdaysPerWeek ?? 5,
          contractValueCents: initial?.contractValueCents ?? 0,
          budgetLines: initial?.budgetLines ?? [],
          reviewComment: initial?.reviewComment ?? null,
          revisions: initial?.revisions ?? [],
        },
        submit,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mx-auto max-w-3xl">
      <CardHeader className="space-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge variant="secondary">Step {step} of 7</Badge>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => handlePersist(false)} disabled={saving} className="touch-target gap-1.5">
              <Save className="h-4 w-4" />
              Save draft
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="touch-target">
              Close
            </Button>
          </div>
        </div>
        <CardTitle className="text-xl">
          {step === 1 && "1. Road name, direction & GPS points"}
          {step === 2 && "2. Confirm along-road distance"}
          {step === 3 && "3. Road type & verge strips"}
          {step === 4 && "4. Clearing widths (metres)"}
          {step === 5 && "5. Relative difficulty"}
          {step === 6 && "6. Work required & exclusions"}
          {step === 7 && "7. Review & send to management"}
        </CardTitle>
        <CardDescription>Save at any step and resume later. No calculations needed.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="as-name">Job or road name</Label>
              <Input id="as-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. R63 Graaff-Reinet Verge Clearing" className="touch-target" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="as-road">Road / area</Label>
                <Input id="as-road" value={roadOrArea} onChange={(e) => setRoadOrArea(e.target.value)} placeholder="e.g. R63 km 10 to km 20" className="touch-target" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="as-cust">Customer (optional)</Label>
                <Input id="as-cust" value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="touch-target" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="as-dir">Travel direction (Start → End)</Label>
              <Input id="as-dir" value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. Heading North from town bridge" className="touch-target" />
            </div>
            <div className="rounded-md border border-border bg-muted/40 p-3 space-y-3">
              <p className="text-xs font-semibold">Optional GPS start & end points (capture only when safely stopped)</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button type="button" variant="outline" onClick={() => captureGps("start")} className="touch-target gap-2">
                  <MapPin className="h-4 w-4" />
                  {startGps ? `Start: ${startGps.lat}, ${startGps.lng}` : "Capture GPS start"}
                </Button>
                <Button type="button" variant="outline" onClick={() => captureGps("end")} className="touch-target gap-2">
                  <MapPin className="h-4 w-4" />
                  {endGps ? `End: ${endGps.lat}, ${endGps.lng}` : "Capture GPS end"}
                </Button>
              </div>
              {gpsUnavailableReason && (
                <p className="text-xs text-status-warn">{gpsUnavailableReason}</p>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Distance source</Label>
                <Select value={distanceSource} onValueChange={(v) => setDistanceSource(v as DistanceSource)}>
                  <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual_distance">Manual road distance (odometer / map)</SelectItem>
                    <SelectItem value="manual_chainage">Manual road chainage markers</SelectItem>
                    <SelectItem value="gps_route">GPS along-road route</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="as-km">Along-road distance (km)</Label>
                <Input id="as-km" type="number" step="0.1" min="0.1" value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} className="touch-target tabular-money text-lg font-semibold" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Accepted road distance: <strong>{acceptedDistanceMeters.toLocaleString()} metres</strong> ({(acceptedDistanceMeters / 1000).toFixed(2)} km). Straight-line GPS distance is never substituted silently.
            </p>
            <div className="space-y-1">
              <Label htmlFor="as-dist-reason">Source / override note (optional)</Label>
              <Input id="as-dist-reason" value={distanceOverrideReason} onChange={(e) => setDistanceOverrideReason(e.target.value)} placeholder="e.g. Measured by bakkie odometer from km 0 to km 10" className="touch-target" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="as-prov" checked={distanceProvisional} onCheckedChange={(v) => setDistanceProvisional(Boolean(v))} />
              <Label htmlFor="as-prov" className="text-xs">Mark distance provisional (captured offline / pending route check)</Label>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            {sections.map((sec, idx) => (
              <div key={sec.id} className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Input
                    value={sec.label}
                    onChange={(e) => updateSection(idx, { label: e.target.value })}
                    className="max-w-xs font-semibold"
                  />
                  <div className="flex items-center gap-2">
                    <Select value={sec.carriageway} onValueChange={(v) => setCarriageway(idx, v as CarriagewayType)}>
                      <SelectTrigger className="w-44 touch-target"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="single">Single carriageway (2 verges)</SelectItem>
                        <SelectItem value="dual">Dual carriageway (4 verges)</SelectItem>
                      </SelectContent>
                    </Select>
                    {sections.length > 1 && (
                      <Button type="button" variant="ghost" size="icon" onClick={() => setSections((p) => p.filter((_, i) => i !== idx))} aria-label="Remove section">
                        <Trash2 className="h-4 w-4 text-status-danger" />
                      </Button>
                    )}
                  </div>
                </div>
                {sections.length > 1 && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Start chainage (m)</Label>
                      <Input type="number" min="0" value={sec.startChainageMeters} onChange={(e) => updateSection(idx, { startChainageMeters: Number(e.target.value) })} className="touch-target" />
                    </div>
                    <div>
                      <Label className="text-xs">End chainage (m)</Label>
                      <Input type="number" min="0" value={sec.endChainageMeters} onChange={(e) => updateSection(idx, { endChainageMeters: Number(e.target.value) })} className="touch-target" />
                    </div>
                  </div>
                )}
                <CarriagewayDiagram
                  carriageway={sec.carriageway}
                  selectedSides={sec.strips.map((s) => s.side)}
                  directionLabel={direction}
                  onToggleSide={(side) => toggleStripSide(idx, side)}
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setSections((prev) => [
                  ...prev,
                  {
                    ...makeDefaultSection(acceptedDistanceMeters),
                    id: `sec-${Date.now()}`,
                    label: `Section ${prev.length + 1}`,
                    startChainageMeters: prev[prev.length - 1]?.endChainageMeters ?? 0,
                    endChainageMeters: (prev[prev.length - 1]?.endChainageMeters ?? 0) + 1000,
                  },
                ])
              }
              className="touch-target gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Add another section (advanced variable road layout)
            </Button>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            {sections.map((sec, sIdx) => (
              <div key={sec.id} className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm font-semibold">{sec.label}</p>
                {sec.strips.map((strip, stIdx) => (
                  <div key={strip.id} className="space-y-2 rounded-md bg-muted/40 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium capitalize">{strip.side.replace(/_/g, " ")}</span>
                      <Badge variant={strip.widthMeters === null ? "destructive" : "secondary"}>
                        {strip.widthMeters === null ? "Unknown (review)" : `${strip.widthMeters} m wide`}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {QUICK_WIDTHS.map((w) => (
                        <Button
                          key={w}
                          type="button"
                          size="sm"
                          variant={strip.widthMeters === w ? "default" : "outline"}
                          onClick={() => {
                            const next = sec.strips.map((st, i) => (i === stIdx ? { ...st, widthMeters: w } : st));
                            updateSection(sIdx, { strips: next });
                          }}
                          className="touch-target px-3"
                        >
                          {w} m
                        </Button>
                      ))}
                      <Button
                        type="button"
                        size="sm"
                        variant={strip.widthMeters === null ? "destructive" : "outline"}
                        onClick={() => {
                          const next = sec.strips.map((st, i) => (i === stIdx ? { ...st, widthMeters: null } : st));
                          updateSection(sIdx, { strips: next });
                        }}
                        className="touch-target px-3"
                      >
                        Unknown
                      </Button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <Label className="text-xs">Custom width (m)</Label>
                        <Input
                          type="number"
                          step="0.5"
                          min="0.1"
                          value={strip.widthMeters ?? ""}
                          onChange={(e) => {
                            const val = e.target.value ? Number(e.target.value) : null;
                            const next = sec.strips.map((st, i) => (i === stIdx ? { ...st, widthMeters: val } : st));
                            updateSection(sIdx, { strips: next });
                          }}
                          className="touch-target"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Length override (m, optional)</Label>
                        <Input
                          type="number"
                          min="1"
                          placeholder={`${sec.endChainageMeters - sec.startChainageMeters}`}
                          value={strip.lengthOverrideMeters ?? ""}
                          onChange={(e) => {
                            const val = e.target.value ? Number(e.target.value) : null;
                            const next = sec.strips.map((st, i) =>
                              i === stIdx ? { ...st, lengthOverrideMeters: val } : st,
                            );
                            updateSection(sIdx, { strips: next });
                          }}
                          className="touch-target"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            {sections.map((sec, sIdx) => (
              <div key={sec.id} className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm font-semibold">{sec.label} — Compared with first completed job</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(DIFFICULTY_FACTORS) as DifficultyLevel[]).map((level) => {
                    const meta = DIFFICULTY_FACTORS[level];
                    const selected = sec.difficulty === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        onClick={() => updateSection(sIdx, { difficulty: level })}
                        className={`flex touch-target flex-col items-start rounded-md border-2 p-3 text-left transition-colors ${
                          selected ? "border-accent bg-accent/20" : "border-border bg-card hover:bg-muted/40"
                        }`}
                      >
                        <span className="text-sm font-semibold">{meta.label}</span>
                        <span className="text-xs text-muted-foreground">{meta.description}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Reasons (tap all that apply)</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(DIFFICULTY_REASON_LABELS) as DifficultyReason[]).map((reason) => {
                      const active = sec.difficultyReasons.includes(reason);
                      return (
                        <Button
                          key={reason}
                          type="button"
                          size="sm"
                          variant={active ? "default" : "outline"}
                          onClick={() => {
                            const next = active
                              ? sec.difficultyReasons.filter((r) => r !== reason)
                              : [...sec.difficultyReasons, reason];
                            updateSection(sIdx, { difficultyReasons: next });
                          }}
                          className="h-9 text-xs"
                        >
                          {DIFFICULTY_REASON_LABELS[reason]}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {step === 6 && (
          <div className="space-y-4">
            {sections.map((sec, sIdx) => (
              <div key={sec.id} className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-sm font-semibold">{sec.label} — Work required</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(SCOPE_ACTIVITY_LABELS) as ScopeActivity[]).map((act) => {
                    const checked = sec.activities.includes(act);
                    return (
                      <label key={act} className="flex touch-target cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => {
                            const next = checked
                              ? sec.activities.filter((a) => a !== act)
                              : [...sec.activities, act];
                            updateSection(sIdx, { activities: next });
                          }}
                        />
                        <span>{SCOPE_ACTIVITY_LABELS[act]}</span>
                      </label>
                    );
                  })}
                </div>
                <Textarea
                  placeholder="Section notes (safety, access, special obstacles)..."
                  value={sec.notes}
                  onChange={(e) => updateSection(sIdx, { notes: e.target.value })}
                  rows={2}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="as-excl">Exclusions (optional)</Label>
              <Textarea id="as-excl" value={exclusions} onChange={(e) => setExclusions(e.target.value)} placeholder="e.g. Bridges, private driveways, heavy tree felling" rows={2} />
            </div>
          </div>
        )}

        {step === 7 && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Road length (union)</p>
                <p className="text-xl font-bold tabular-money">{(sizing.roadLengthMeters / 1000).toFixed(2)} km</p>
              </div>
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Total verge length</p>
                <p className="text-xl font-bold tabular-money">{(sizing.vergeLengthMeters / 1000).toFixed(2)} km</p>
              </div>
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Physical clearing area</p>
                <p className="text-xl font-bold tabular-money">{sizing.physicalAreaSqm.toLocaleString()} m²</p>
              </div>
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Difficulty-weighted effort</p>
                <p className="text-xl font-bold tabular-money">
                  {sizing.effortUnitsSqm.toLocaleString()} effort-m² ({sizing.weightedDifficultyFactor}×)
                </p>
              </div>
            </div>

            {sizing.unknownWidthCount > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn-bg p-3 text-xs text-status-warn">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{sizing.unknownWidthCount} strip(s) have unknown width and will be flagged for Management review before approval.</span>
              </div>
            )}

            {validationErrors.length > 0 && (
              <div className="rounded-md border border-status-danger/40 bg-status-danger-bg p-3 text-xs text-status-danger">
                {validationErrors.map((e) => (<p key={e}>{e}</p>))}
              </div>
            )}

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-status-ok" />
              <span>Distance source: {distanceSource.replace(/_/g, " ")}{distanceProvisional ? " (Provisional)" : ""}</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))} className="touch-target gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          {step < 7 ? (
            <Button type="button" onClick={() => setStep((s) => Math.min(7, s + 1))} className="touch-target gap-1.5">
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="button" disabled={saving || validationErrors.length > 0} onClick={() => handlePersist(true)} className="touch-target gap-1.5">
              <Send className="h-4 w-4" />
              Submit to management
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}