import * as React from "react";
import { ClientOnly } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CloudOff,
  Flag,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import type { RoutePoint, RoutePointType } from "@/lib/domain/assessment-types";
import {
  calculateRouteMetrics,
  checkPointProximity,
  deleteRoutePoint,
  formatDistanceMeters,
  insertRoutePointAt,
  isPoorGpsAccuracy,
  moveRoutePoint,
  reorderRoutePoint,
  resequenceRoutePoints,
  undoLastRoutePoint,
} from "@/lib/domain/route-geometry";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LazyRouteMapCanvas = React.lazy(() => import("@/components/RouteMapCanvas"));

function makePointId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface RouteCapturePanelProps {
  points: RoutePoint[];
  editable: boolean;
  userEmail: string;
  userId: string | null;
  gpsUnavailableReason: string;
  offlinePendingCount?: number;
  onChangePoints: (nextPoints: RoutePoint[], capturedOfflinePoint?: RoutePoint) => void;
  onGpsUnavailable: (reason: string) => void;
  onSaveRoute?: () => void;
  onSyncOffline?: () => void;
  saving?: boolean;
}

export function RouteCapturePanel({
  points,
  editable,
  userEmail,
  userId,
  gpsUnavailableReason,
  offlinePendingCount = 0,
  onChangePoints,
  onGpsUnavailable,
  onSaveRoute,
  onSyncOffline,
  saving = false,
}: RouteCapturePanelProps) {
  const [capturing, setCapturing] = React.useState<RoutePointType | null>(null);
  const [lastAccuracy, setLastAccuracy] = React.useState<number | null>(null);
  const [lastRequestedType, setLastRequestedType] = React.useState<RoutePointType>("waypoint");
  const [proximityWarning, setProximityWarning] = React.useState<string | null>(null);
  const [insertAfterIndex, setInsertAfterIndex] = React.useState<number | null>(null);
  const [editingPointId, setEditingPointId] = React.useState<string | null>(null);
  const [editLat, setEditLat] = React.useState("");
  const [editLng, setEditLng] = React.useState("");
  const [isOffline, setIsOffline] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOffline(!navigator.onLine);
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const ordered = React.useMemo(
    () => [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber),
    [points],
  );
  const metrics = React.useMemo(() => calculateRouteMetrics(ordered), [ordered]);

  const commitNewPoint = (
    pointType: RoutePointType,
    latitude: number,
    longitude: number,
    accuracyMeters: number | null,
    captureMethod: "gps" | "manual_map",
    insertIdx?: number,
  ) => {
    // Check proximity against previous point (unless replacing an existing start at index 0)
    const checkAgainst =
      pointType === "start" && ordered.length > 0 && ordered[0]?.pointType === "start"
        ? []
        : insertIdx !== undefined
          ? ordered.slice(0, insertIdx)
          : ordered;
    const prox = checkPointProximity(checkAgainst, latitude, longitude, accuracyMeters);
    if (prox.isDuplicate) {
      setProximityWarning(prox.warning);
      toast.error(prox.warning ?? "Duplicate point prevented.");
      return;
    }
    setProximityWarning(prox.warning);

    const id = makePointId();
    const newPt: RoutePoint = {
      id,
      clientPointId: id,
      pointType,
      sequenceNumber: ordered.length,
      latitude,
      longitude,
      gpsAccuracyMeters: accuracyMeters,
      capturedAt: new Date().toISOString(),
      capturedByUserId: userId,
      capturedByEmail: userEmail,
      captureMethod,
    };

    let next: RoutePoint[];
    if (insertIdx !== undefined) {
      next = insertRoutePointAt(ordered, insertIdx, { ...newPt, pointType: "waypoint" });
    } else if (pointType === "start") {
      if (ordered.length > 0 && ordered[0]?.pointType === "start") {
        next = [{ ...newPt, sequenceNumber: 0 }, ...ordered.slice(1)];
      } else {
        next = [{ ...newPt, sequenceNumber: 0 }, ...ordered];
      }
      next = resequenceRoutePoints(next, !ordered.some((p) => p.pointType === "end"));
    } else if (pointType === "end") {
      const withoutEnd = ordered.filter((p) => p.pointType !== "end");
      next = resequenceRoutePoints([...withoutEnd, { ...newPt, sequenceNumber: withoutEnd.length }], false);
    } else {
      // Insert waypoint before end if end already exists, else append
      const endIdx = ordered.findIndex((p) => p.pointType === "end");
      if (endIdx >= 0) {
        next = insertRoutePointAt(ordered, endIdx, newPt);
        next = resequenceRoutePoints(next, false);
      } else {
        next = resequenceRoutePoints([...ordered, newPt], true);
      }
    }

    onChangePoints(next, isOffline ? newPt : undefined);
    const nextMetrics = calculateRouteMetrics(next);
    toast.success(
      `${pointType === "start" ? "Start" : pointType === "end" ? "End" : "Waypoint"} captured (${formatDistanceMeters(nextMetrics.totalDistanceMeters)} total).`,
    );
  };

  const captureGpsPoint = (pointType: RoutePointType) => {
    setLastRequestedType(pointType);
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      onGpsUnavailable("Browser geolocation unavailable — use manual map entry or manual distance.");
      toast.info("GPS unavailable. Tap the map or enter road distance manually.");
      return;
    }
    setCapturing(pointType);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCapturing(null);
        const acc = Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null;
        setLastAccuracy(acc);
        commitNewPoint(
          pointType,
          Number(pos.coords.latitude.toFixed(6)),
          Number(pos.coords.longitude.toFixed(6)),
          acc,
          "gps",
        );
      },
      () => {
        setCapturing(null);
        onGpsUnavailable("GPS permission denied or signal unavailable — use manual map entry or manual distance.");
        toast.info("GPS denied or unavailable. You can place points on the map or enter distance manually.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const handleMapClickAdd = (lat: number, lng: number) => {
    if (!editable) return;
    if (insertAfterIndex !== null) {
      commitNewPoint("waypoint", lat, lng, null, "manual_map", insertAfterIndex + 1);
      setInsertAfterIndex(null);
      return;
    }
    const nextType: RoutePointType =
      ordered.length === 0 ? "start" : "waypoint";
    commitNewPoint(nextType, lat, lng, null, "manual_map");
  };

  const handleMarkerDragMove = (pointId: string, lat: number, lng: number) => {
    if (!editable) return;
    const next = moveRoutePoint(ordered, pointId, lat, lng, "manual_map");
    onChangePoints(next);
  };

  const startEditCoords = (pt: RoutePoint) => {
    setEditingPointId(pt.id);
    setEditLat(String(pt.latitude));
    setEditLng(String(pt.longitude));
  };

  const saveEditCoords = (pointId: string) => {
    const lat = Number(editLat);
    const lng = Number(editLng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      toast.error("Enter valid latitude (-90 to 90) and longitude (-180 to 180).");
      return;
    }
    const next = moveRoutePoint(ordered, pointId, Number(lat.toFixed(6)), Number(lng.toFixed(6)), "manual_map");
    onChangePoints(next);
    setEditingPointId(null);
    toast.success("Point coordinates updated and distance recalculated.");
  };

  const poorAccuracy = isPoorGpsAccuracy(lastAccuracy);
  let waypointCounter = 0;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-3 sm:p-4">
      {/* Safety reminder */}
      <div className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-xs text-status-warn">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>Safety first:</strong> Capture GPS points only when safely stopped off the road — never while driving.
        </span>
      </div>

      {/* Live telemetry readout */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-border bg-card p-2.5">
          <p className="text-[11px] text-muted-foreground">GPS accuracy</p>
          <p className="text-sm font-bold tabular-money">
            {lastAccuracy !== null ? `±${lastAccuracy} m` : ordered.length > 0 && ordered[ordered.length - 1]?.gpsAccuracyMeters !== null ? `±${Math.round(ordered[ordered.length - 1]!.gpsAccuracyMeters!)} m` : "Ready"}
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-2.5">
          <p className="text-[11px] text-muted-foreground">Points captured</p>
          <p className="text-sm font-bold tabular-money">
            {metrics.pointCount} {metrics.pointCount === 1 ? "point" : "points"}
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-2.5">
          <p className="text-[11px] text-muted-foreground">Measured road</p>
          <p className="text-sm font-bold tabular-money" data-testid="route-measured-distance">
            {formatDistanceMeters(metrics.totalDistanceMeters)}
          </p>
        </div>
      </div>

      {/* Poor GPS accuracy warning with retry */}
      {poorAccuracy && editable && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-status-warn/50 bg-status-warn-bg p-2.5 text-xs text-status-warn">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            GPS accuracy is poor (±{lastAccuracy} m). Wait a few seconds in open sky and retry.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => captureGpsPoint(lastRequestedType)}
            className="h-9 gap-1.5 bg-card"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry GPS
          </Button>
        </div>
      )}

      {/* Duplicate / close-proximity warning */}
      {proximityWarning && (
        <div className="flex items-start justify-between gap-2 rounded-md border border-status-warn/50 bg-status-warn-bg p-2.5 text-xs text-status-warn">
          <span className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{proximityWarning}</span>
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setProximityWarning(null)} className="h-7 px-2 text-xs">
            Dismiss
          </Button>
        </div>
      )}

      {/* Offline status / sync bar */}
      {(isOffline || offlinePendingCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5">
            <CloudOff className="h-4 w-4 text-status-warn" />
            {isOffline
              ? "Offline mode: waypoints are queued on this device and will sync when connectivity returns."
              : `${offlinePendingCount} offline waypoint(s) ready to sync.`}
          </span>
          {!isOffline && offlinePendingCount > 0 && onSyncOffline && (
            <Button type="button" size="sm" variant="outline" onClick={onSyncOffline} className="h-8 gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Sync now
            </Button>
          )}
        </div>
      )}

      {/* Large mobile-first GPS capture buttons */}
      {editable && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Button
            type="button"
            variant={metrics.hasStart ? "outline" : "default"}
            disabled={capturing !== null}
            onClick={() => captureGpsPoint("start")}
            className="touch-target h-12 justify-start gap-2 text-sm font-semibold"
          >
            <MapPin className="h-4 w-4 shrink-0" />
            {capturing === "start" ? "Getting GPS..." : "Mark start of road"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={capturing !== null}
            onClick={() => captureGpsPoint("waypoint")}
            className="touch-target h-12 justify-start gap-2 text-sm font-semibold"
          >
            <Plus className="h-4 w-4 shrink-0" />
            {capturing === "waypoint" ? "Getting GPS..." : "Add waypoint"}
          </Button>
          <Button
            type="button"
            variant={metrics.hasEnd ? "outline" : "default"}
            disabled={capturing !== null}
            onClick={() => captureGpsPoint("end")}
            className="touch-target h-12 justify-start gap-2 text-sm font-semibold"
          >
            <Flag className="h-4 w-4 shrink-0" />
            {capturing === "end" ? "Getting GPS..." : "Mark end of road"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={ordered.length === 0}
            onClick={() => {
              onChangePoints(undoLastRoutePoint(ordered));
              setProximityWarning(null);
              toast.info("Last route point removed.");
            }}
            className="touch-target h-11 justify-start gap-2 text-sm"
          >
            <Undo2 className="h-4 w-4 shrink-0" />
            Undo last point
          </Button>
          {onSaveRoute && (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onSaveRoute}
              className="touch-target h-11 justify-start gap-2 text-sm sm:col-span-1 lg:col-span-2"
            >
              <Save className="h-4 w-4 shrink-0" />
              {saving ? "Saving route..." : "Save route (resume later)"}
            </Button>
          )}
        </div>
      )}

      {gpsUnavailableReason && (
        <p className="text-xs text-status-warn">{gpsUnavailableReason}</p>
      )}

      {/* Interactive Route Map (client-only lazy import) */}
      <ClientOnly
        fallback={
          <div className="flex h-72 items-center justify-center rounded-md border border-border bg-muted/40 text-xs text-muted-foreground">
            Loading route map...
          </div>
        }
      >
        <React.Suspense
          fallback={
            <div className="flex h-72 items-center justify-center rounded-md border border-border bg-muted/40 text-xs text-muted-foreground">
              Loading route map...
            </div>
          }
        >
          <LazyRouteMapCanvas
            points={ordered}
            editable={editable}
            insertAfterIndex={insertAfterIndex}
            onMapClickAdd={handleMapClickAdd}
            onMarkerDragMove={handleMarkerDragMove}
          />
        </React.Suspense>
      </ClientOnly>

      {/* Waypoint sequence list with segment & cumulative distances */}
      {ordered.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Route points ({ordered.length}) — {metrics.isComplete ? "Complete route" : "Incomplete route (save & resume anytime)"}
            </p>
            {metrics.isComplete && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <CheckCircle2 className="h-3 w-3 text-status-ok" />
                Start & End captured
              </Badge>
            )}
          </div>

          <div className="space-y-1.5">
            {ordered.map((pt, idx) => {
              const segDist = idx > 0 ? (metrics.segmentDistancesMeters[idx - 1] ?? 0) : null;
              const cumDist = metrics.cumulativeDistancesMeters[idx] ?? 0;
              let label = "Start";
              if (pt.pointType === "waypoint") {
                waypointCounter += 1;
                label = `Waypoint ${waypointCounter}`;
              } else if (pt.pointType === "end") {
                label = "End";
              }
              const isEditing = editingPointId === pt.id;

              return (
                <div key={pt.id} className="rounded-md border border-border bg-card p-2.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={pt.pointType === "start" ? "default" : pt.pointType === "end" ? "destructive" : "secondary"}>
                        {label}
                      </Badge>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {pt.latitude.toFixed(5)}, {pt.longitude.toFixed(5)}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {pt.captureMethod === "gps"
                          ? `GPS${pt.gpsAccuracyMeters !== null ? ` ±${Math.round(pt.gpsAccuracyMeters)}m` : ""}`
                          : "Map"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 tabular-money">
                      {segDist !== null && (
                        <span className="text-muted-foreground">+{formatDistanceMeters(segDist)}</span>
                      )}
                      <strong className="text-foreground">Cum: {formatDistanceMeters(cumDist)}</strong>
                    </div>
                  </div>

                  {editable && !isEditing && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={idx === 0}
                        onClick={() => onChangePoints(reorderRoutePoint(ordered, idx, idx - 1))}
                        className="h-8 px-2 text-xs"
                        aria-label={`Move ${label} up`}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={idx === ordered.length - 1}
                        onClick={() => onChangePoints(reorderRoutePoint(ordered, idx, idx + 1))}
                        className="h-8 px-2 text-xs"
                        aria-label={`Move ${label} down`}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      {idx < ordered.length - 1 && (
                        <Button
                          type="button"
                          size="sm"
                          variant={insertAfterIndex === idx ? "default" : "outline"}
                          onClick={() => setInsertAfterIndex(insertAfterIndex === idx ? null : idx)}
                          className="h-8 gap-1 px-2 text-xs"
                        >
                          <Plus className="h-3 w-3" />
                          {insertAfterIndex === idx ? "Tap map..." : "Insert after"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => startEditCoords(pt)}
                        className="h-8 gap-1 px-2 text-xs"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onChangePoints(deleteRoutePoint(ordered, pt.id))}
                        className="h-8 px-2 text-status-danger"
                        aria-label={`Delete ${label}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}

                  {editable && isEditing && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <div>
                        <Label className="text-[11px]">Latitude</Label>
                        <Input value={editLat} onChange={(e) => setEditLat(e.target.value)} className="h-9 text-xs font-mono" />
                      </div>
                      <div>
                        <Label className="text-[11px]">Longitude</Label>
                        <Input value={editLng} onChange={(e) => setEditLng(e.target.value)} className="h-9 text-xs font-mono" />
                      </div>
                      <div className="flex items-end gap-1.5">
                        <Button type="button" size="sm" onClick={() => saveEditCoords(pt.id)} className="h-9 text-xs">
                          Apply
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingPointId(null)} className="h-9 text-xs">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}