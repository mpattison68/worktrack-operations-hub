import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertOctagon,
  CheckCircle2,
  Fuel,
  Plus,
  ShieldAlert,
  Truck,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs } from "@/lib/data/repository";
import {
  createAsset,
  listIncrementEBundle,
  recordAssetServiceEntry,
  recordPreUseCheck,
  resolveAssetDefect,
} from "@/lib/data/increment-e-repository";
import {
  calculateAssetFuelConsumption,
  evaluatePreUseCheck,
  PRE_USE_CHECK_ITEMS,
} from "@/lib/domain/increment-e-calc";
import type {
  AssetType,
  CheckItemResult,
  PreUseCheckItemKey,
} from "@/lib/domain/increment-e-types";
import { can } from "@/lib/permissions";
import { formatDateSA, formatZarCents, parseZarToCents, todaySAST } from "@/lib/format";
import { en } from "@/i18n/en";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_ITEMS: Record<PreUseCheckItemKey, CheckItemResult> = {
  oil: "ok",
  coolant: "ok",
  leaks: "ok",
  tyres: "ok",
  brakes_lights: "ok",
  warning_lights: "ok",
};

export function VehiclesPanel() {
  const { session, isOnline } = useWorkTrackAuth();
  const qc = useQueryClient();

  const bundleQuery = useQuery({
    queryKey: ["increment-e", session?.businessId, session?.userId],
    queryFn: () => listIncrementEBundle(session!),
    enabled: Boolean(session),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });

  const assets = bundleQuery.data?.assets ?? [];
  const checks = bundleQuery.data?.checks ?? [];
  const defects = bundleQuery.data?.defects ?? [];
  const services = bundleQuery.data?.services ?? [];
  const jobs = jobsQuery.data ?? [];

  const [selectedAssetId, setSelectedAssetId] = React.useState<string>("");
  const [selectedJobId, setSelectedJobId] = React.useState<string>("");
  const [checkDate, setCheckDate] = React.useState<string>(() => todaySAST());
  const [odometerInput, setOdometerInput] = React.useState<string>("");
  const [items, setItems] = React.useState<Record<PreUseCheckItemKey, CheckItemResult>>({
    ...DEFAULT_ITEMS,
  });
  const [comment, setComment] = React.useState("");
  const [photoNote, setPhotoNote] = React.useState("");
  const [resolveTargetId, setResolveTargetId] = React.useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = React.useState("");

  const [addAssetOpen, setAddAssetOpen] = React.useState(false);
  const [newAssetType, setNewAssetType] = React.useState<AssetType>("truck");
  const [newAssetName, setNewAssetName] = React.useState("");
  const [newAssetModel, setNewAssetModel] = React.useState("");
  const [newAssetReg, setNewAssetReg] = React.useState("");
  const [newAssetVin, setNewAssetVin] = React.useState("");
  const [newAssetOdo, setNewAssetOdo] = React.useState("");

  const [serviceAssetId, setServiceAssetId] = React.useState<string | null>(null);
  const [serviceType, setServiceType] = React.useState<"fuel" | "service" | "repair">("fuel");
  const [serviceDate, setServiceDate] = React.useState<string>(() => todaySAST());
  const [serviceOdo, setServiceOdo] = React.useState("");
  const [serviceLitres, setServiceLitres] = React.useState("");
  const [serviceCost, setServiceCost] = React.useState("");
  const [serviceDesc, setServiceDesc] = React.useState("");

  React.useEffect(() => {
    if (!selectedAssetId && assets.length > 0) {
      setSelectedAssetId(assets[0]!.id);
      if (assets[0]!.odometerKm !== null) {
        setOdometerInput(String(assets[0]!.odometerKm));
      }
    }
  }, [assets, selectedAssetId]);

  React.useEffect(() => {
    if (!selectedJobId && jobs.length > 0) {
      setSelectedJobId(jobs[0]!.id);
    }
  }, [jobs, selectedJobId]);

  const liveEval = evaluatePreUseCheck(items);
  const openDefects = defects.filter((d) => d.status === "open");
  const availableAlternates = assets.filter(
    (a) => a.id !== selectedAssetId && a.status === "available" && a.active,
  );

  const saveCheckMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");
      if (!selectedAssetId) throw new Error("Select a vehicle or asset.");
      const odoNum = odometerInput.trim() ? Number(odometerInput) : null;
      if (odoNum !== null && (Number.isNaN(odoNum) || odoNum < 0)) {
        throw new Error("Enter a valid non-negative odometer reading.");
      }
      return recordPreUseCheck(session, {
        assetId: selectedAssetId,
        jobId: selectedJobId || null,
        checkDate,
        odometerKm: odoNum,
        items,
        comment,
        photoNote: photoNote.trim() || null,
        isOffline: !isOnline,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      if (res.check.stopUseTriggered) {
        toast.error(
          "STOP DO NOT USE triggered — vehicle marked unavailable and safety alert queued.",
        );
      } else {
        toast.success("Daily pre-use check saved.");
      }
      setComment("");
      setPhotoNote("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resolveMutation = useMutation({
    mutationFn: async () => {
      if (!session || !resolveTargetId) throw new Error("Missing defect");
      return resolveAssetDefect(session, resolveTargetId, resolutionNotes);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success("Defect resolved and vehicle availability updated.");
      setResolveTargetId(null);
      setResolutionNotes("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const addAssetMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");
      const odo = newAssetOdo.trim() ? Number(newAssetOdo) : null;
      if (odo !== null && (Number.isNaN(odo) || odo < 0)) {
        throw new Error("Odometer must be a positive number.");
      }
      return createAsset(session, {
        assetType: newAssetType,
        name: newAssetName,
        makeModel: newAssetModel,
        registration: newAssetReg || null,
        vin: newAssetVin || null,
        ownerName: session.businessName,
        purchaseCostCents: null,
        odometerKm: odo,
        serviceIntervalKm: newAssetType === "truck" || newAssetType === "bakkie" ? 15000 : null,
        licenceExpiryDate: null,
        insuranceExpiryDate: null,
        assignedJobId: selectedJobId || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success("Asset added to register.");
      setAddAssetOpen(false);
      setNewAssetName("");
      setNewAssetModel("");
      setNewAssetReg("");
      setNewAssetVin("");
      setNewAssetOdo("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const logServiceMutation = useMutation({
    mutationFn: async () => {
      if (!session || !serviceAssetId) throw new Error("Select an asset");
      const costCents = parseZarToCents(serviceCost);
      if (costCents === null || costCents < 0) {
        throw new Error("Enter a valid ZAR cost amount.");
      }
      const odo = serviceOdo.trim() ? Number(serviceOdo) : null;
      const litres = serviceLitres.trim() ? Number(serviceLitres) : null;
      return recordAssetServiceEntry(session, {
        assetId: serviceAssetId,
        entryDate: serviceDate,
        entryType: serviceType,
        odometerKm: odo,
        litres,
        costCents,
        description: serviceDesc,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success("Service / fuel entry saved.");
      setServiceAssetId(null);
      setServiceCost("");
      setServiceDesc("");
      setServiceLitres("");
      setServiceOdo("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!session) return null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{en.vehicles.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{en.vehicles.subtitle}</p>
        </div>
        {can(session.role, "vehicles.manage") && (
          <Button className="touch-target gap-2" onClick={() => setAddAssetOpen(true)}>
            <Plus className="h-4 w-4" />
            Add vehicle / equipment
          </Button>
        )}
      </div>

      {openDefects.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border-2 border-status-danger bg-status-danger-bg p-4 text-status-danger"
        >
          <AlertOctagon className="mt-0.5 h-6 w-6 shrink-0" />
          <div className="space-y-1">
            <p className="text-base font-bold uppercase tracking-wide">
              {openDefects.length} active STOP DO NOT USE defect(s)
            </p>
            {openDefects.map((d) => (
              <p key={d.id} className="text-sm">
                • {d.summary} ({formatDateSA(d.reportedDate)})
              </p>
            ))}
          </div>
        </div>
      )}

      <Tabs defaultValue="check">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="check" className="min-h-11">
            {en.vehicles.tabChecks}
          </TabsTrigger>
          <TabsTrigger value="defects" className="min-h-11">
            {en.vehicles.tabDefects} ({openDefects.length})
          </TabsTrigger>
          <TabsTrigger value="register" className="min-h-11">
            {en.vehicles.tabRegister} ({assets.length})
          </TabsTrigger>
        </TabsList>

        {/* Daily pre-use check tab */}
        <TabsContent value="check" className="mt-4 space-y-4">
          {liveEval.stopUseTriggered && (
            <div
              role="alert"
              className="rounded-lg border-2 border-status-danger bg-status-danger-bg p-4 text-status-danger"
            >
              <div className="flex items-center gap-2 text-lg font-extrabold">
                <AlertOctagon className="h-6 w-6 shrink-0" />
                <span>{en.vehicles.stopDoNotUse}</span>
              </div>
              <p className="mt-1 text-sm">{en.vehicles.stopDoNotUseDetail}</p>
              {availableAlternates.length > 0 && (
                <p className="mt-2 text-xs font-semibold">
                  Safe alternate asset(s) available:{" "}
                  {availableAlternates.map((a) => a.name).join(", ")}
                </p>
              )}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Daily pre-use safety check</CardTitle>
              <CardDescription>
                Tap OK, Problem, or Not checked for every item before driving. Safety-critical
                problems or unchecked items trigger an immediate STOP DO NOT USE warning.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="check-asset">Vehicle / asset</Label>
                  <select
                    id="check-asset"
                    value={selectedAssetId}
                    onChange={(e) => {
                      setSelectedAssetId(e.target.value);
                      const picked = assets.find((a) => a.id === e.target.value);
                      setOdometerInput(picked?.odometerKm != null ? String(picked.odometerKm) : "");
                    }}
                    className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {assets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.status === "unavailable_defect" ? "UNAVAILABLE" : "Available"})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="check-date">Check date (SAST)</Label>
                  <Input
                    id="check-date"
                    type="date"
                    value={checkDate}
                    onChange={(e) => setCheckDate(e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="check-odo">Odometer (km)</Label>
                  <Input
                    id="check-odo"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={odometerInput}
                    onChange={(e) => setOdometerInput(e.target.value)}
                    placeholder="e.g. 148300"
                    className="h-11"
                  />
                </div>
              </div>

              <div className="space-y-3">
                {PRE_USE_CHECK_ITEMS.map((item) => {
                  const current = items[item.key];
                  return (
                    <div
                      key={item.key}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                    >
                      <div>
                        <p className="text-sm font-semibold">{item.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.critical ? "Safety-critical item" : "Standard check item"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(
                          [
                            { val: "ok", label: "OK" },
                            { val: "problem", label: "Problem" },
                            { val: "not_checked", label: "Not checked" },
                          ] as const
                        ).map((opt) => (
                          <Button
                            key={opt.val}
                            type="button"
                            size="sm"
                            variant={current === opt.val ? "default" : "outline"}
                            onClick={() =>
                              setItems((prev) => ({ ...prev, [item.key]: opt.val }))
                            }
                            className={`touch-target min-w-[84px] ${
                              current === opt.val && opt.val !== "ok"
                                ? "bg-status-danger text-white hover:bg-status-danger/90"
                                : ""
                            }`}
                          >
                            {opt.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="check-comment">Comment / defect details</Label>
                  <Textarea
                    id="check-comment"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Describe any leak, warning light, or tyre wear…"
                    rows={2}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="check-photo">Photo evidence note (optional)</Label>
                  <Input
                    id="check-photo"
                    value={photoNote}
                    onChange={(e) => setPhotoNote(e.target.value)}
                    placeholder="e.g. Photo of oil dipstick taken on phone"
                    className="h-11"
                  />
                </div>
              </div>

              <Button
                type="button"
                onClick={() => saveCheckMutation.mutate()}
                disabled={saveCheckMutation.isPending}
                className="touch-target w-full sm:w-auto"
                variant={liveEval.stopUseTriggered ? "destructive" : "default"}
              >
                {liveEval.stopUseTriggered
                  ? "Log STOP DO NOT USE defect & mark unavailable"
                  : "Save daily pre-use check"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent pre-use checks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No checks logged yet.</p>
              ) : (
                checks.slice(0, 8).map((c) => {
                  const asset = assets.find((a) => a.id === c.assetId);
                  return (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                    >
                      <div>
                        <p className="font-semibold">
                          {asset?.name ?? c.assetId} · {formatDateSA(c.checkDate)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          By {c.checkedByName}
                          {c.odometerKm !== null ? ` · ${c.odometerKm.toLocaleString()} km` : ""}
                          {c.comment ? ` · ${c.comment}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {c.syncStatus === "queued_offline" && (
                          <Badge variant="outline">Queued offline</Badge>
                        )}
                        <Badge
                          variant={c.stopUseTriggered ? "destructive" : "outline"}
                          className="gap-1"
                        >
                          {c.stopUseTriggered ? (
                            <>
                              <AlertOctagon className="h-3.5 w-3.5" />
                              STOP DO NOT USE
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5 text-status-ok" />
                              Safe to use
                            </>
                          )}
                        </Badge>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Open & resolved defects tab */}
        <TabsContent value="defects" className="mt-4 space-y-3">
          {defects.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No vehicle defects recorded.
              </CardContent>
            </Card>
          ) : (
            defects.map((d) => (
              <Card key={d.id}>
                <CardContent className="flex flex-wrap items-start justify-between gap-3 pt-5">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={d.status === "open" ? "destructive" : "outline"}>
                        {d.status === "open" ? "OPEN — STOP DO NOT USE" : "Resolved"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        Reported {formatDateSA(d.reportedDate)} by {d.reportedByName}
                      </span>
                    </div>
                    <p className="text-sm font-semibold">{d.summary}</p>
                    {d.resolutionNotes && (
                      <p className="text-xs text-muted-foreground">
                        Resolution ({d.resolvedByName}, {formatDateSA(d.resolvedAt)}):{" "}
                        {d.resolutionNotes}
                      </p>
                    )}
                  </div>
                  {d.status === "open" && can(session.role, "vehicles.resolve_defect") && (
                    <Button
                      size="sm"
                      className="touch-target gap-1.5"
                      onClick={() => setResolveTargetId(d.id)}
                    >
                      <ShieldAlert className="h-4 w-4" />
                      Log resolution & clear stop-use
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Assets & service register tab */}
        <TabsContent value="register" className="mt-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {assets.map((asset) => {
              const assetServices = services.filter((s) => s.assetId === asset.id);
              const fuel = calculateAssetFuelConsumption(assetServices);
              const kmSinceService =
                asset.odometerKm !== null && asset.lastServiceOdometerKm !== null
                  ? asset.odometerKm - asset.lastServiceOdometerKm
                  : null;
              return (
                <Card key={asset.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Truck className="h-4 w-4 text-muted-foreground" />
                          {asset.name}
                        </CardTitle>
                        <CardDescription>
                          {asset.makeModel}
                          {asset.registration ? ` · ${asset.registration}` : ""}
                        </CardDescription>
                      </div>
                      <Badge
                        variant={
                          asset.status === "unavailable_defect" ? "destructive" : "outline"
                        }
                      >
                        {asset.status === "unavailable_defect" ? "Unavailable (defect)" : "Available"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/40 p-2.5">
                      <div>
                        <span className="text-muted-foreground">Odometer:</span>{" "}
                        <strong>
                          {asset.odometerKm !== null
                            ? `${asset.odometerKm.toLocaleString()} km`
                            : "N/A"}
                        </strong>
                      </div>
                      <div>
                        <span className="text-muted-foreground">VIN:</span>{" "}
                        <strong>
                          {can(session.role, "vehicles.view_vin")
                            ? asset.vin ?? "—"
                            : en.vehicles.vinRestricted}
                        </strong>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Licence expiry:</span>{" "}
                        <strong>{formatDateSA(asset.licenceExpiryDate)}</strong>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Since service:</span>{" "}
                        <strong>
                          {kmSinceService !== null
                            ? `${kmSinceService.toLocaleString()} / ${(asset.serviceIntervalKm ?? 15000).toLocaleString()} km`
                            : "—"}
                        </strong>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Fuel className="h-3.5 w-3.5" />
                        {fuel.label}
                      </span>
                      {can(session.role, "vehicles.manage") && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9 gap-1.5"
                          onClick={() => setServiceAssetId(asset.id)}
                        >
                          <Wrench className="h-3.5 w-3.5" />
                          Log fuel / service
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>

      {/* Resolve defect dialog */}
      <Dialog open={Boolean(resolveTargetId)} onOpenChange={(o) => !o && setResolveTargetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve safety defect</DialogTitle>
            <DialogDescription>
              Record the repair or inspection evidence before returning this asset to service.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="res-notes">Resolution notes & responsible person</Label>
            <Textarea
              id="res-notes"
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              placeholder="e.g. Oil topped up and sump plug gasket replaced by workshop; tested OK."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveTargetId(null)}>
              {en.common.cancel}
            </Button>
            <Button onClick={() => resolveMutation.mutate()} disabled={resolveMutation.isPending}>
              Confirm resolution
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add asset dialog */}
      <Dialog open={addAssetOpen} onOpenChange={setAddAssetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add vehicle or equipment</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="a-type">Type</Label>
                <select
                  id="a-type"
                  value={newAssetType}
                  onChange={(e) => setNewAssetType(e.target.value as AssetType)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="truck">Truck</option>
                  <option value="bakkie">Bakkie</option>
                  <option value="trailer">Trailer</option>
                  <option value="brush_cutter">Brush cutter</option>
                  <option value="chainsaw">Chainsaw</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="a-odo">Odometer (km)</Label>
                <Input
                  id="a-odo"
                  type="number"
                  min={0}
                  value={newAssetOdo}
                  onChange={(e) => setNewAssetOdo(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="a-name">Display name</Label>
              <Input
                id="a-name"
                value={newAssetName}
                onChange={(e) => setNewAssetName(e.target.value)}
                placeholder="e.g. Crew Truck 03"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="a-model">Make & model</Label>
              <Input
                id="a-model"
                value={newAssetModel}
                onChange={(e) => setNewAssetModel(e.target.value)}
                placeholder="e.g. Isuzu NPR 400"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="a-reg">Registration</Label>
                <Input
                  id="a-reg"
                  value={newAssetReg}
                  onChange={(e) => setNewAssetReg(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="a-vin">VIN (restricted)</Label>
                <Input
                  id="a-vin"
                  value={newAssetVin}
                  onChange={(e) => setNewAssetVin(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddAssetOpen(false)}>
              {en.common.cancel}
            </Button>
            <Button onClick={() => addAssetMutation.mutate()} disabled={addAssetMutation.isPending}>
              {en.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log service/fuel dialog */}
      <Dialog open={Boolean(serviceAssetId)} onOpenChange={(o) => !o && setServiceAssetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log fuel, service or repair</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="s-type">Entry type</Label>
                <select
                  id="s-type"
                  value={serviceType}
                  onChange={(e) => setServiceType(e.target.value as "fuel" | "service" | "repair")}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="fuel">Fuel fill-up</option>
                  <option value="service">Scheduled service</option>
                  <option value="repair">Repair</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="s-date">Date</Label>
                <Input
                  id="s-date"
                  type="date"
                  value={serviceDate}
                  onChange={(e) => setServiceDate(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="s-cost">Cost (ZAR)</Label>
                <Input
                  id="s-cost"
                  value={serviceCost}
                  onChange={(e) => setServiceCost(e.target.value)}
                  placeholder="2450.00"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="s-odo">Odometer</Label>
                <Input
                  id="s-odo"
                  type="number"
                  value={serviceOdo}
                  onChange={(e) => setServiceOdo(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="s-litres">Litres</Label>
                <Input
                  id="s-litres"
                  type="number"
                  step="0.1"
                  value={serviceLitres}
                  onChange={(e) => setServiceLitres(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="s-desc">Description</Label>
              <Input
                id="s-desc"
                value={serviceDesc}
                onChange={(e) => setServiceDesc(e.target.value)}
                placeholder="e.g. Full diesel tank at depot"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setServiceAssetId(null)}>
              {en.common.cancel}
            </Button>
            <Button
              onClick={() => logServiceMutation.mutate()}
              disabled={logServiceMutation.isPending}
            >
              {en.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}