import * as React from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RoutePoint } from "@/lib/domain/assessment-types";
import { calculateRouteMetrics, formatDistanceMeters } from "@/lib/domain/route-geometry";

export interface RouteMapCanvasProps {
  points: RoutePoint[];
  editable: boolean;
  insertAfterIndex: number | null;
  onMapClickAdd?: (lat: number, lng: number) => void;
  onMarkerDragMove?: (pointId: string, lat: number, lng: number) => void;
}

// Default center: Eastern Cape / South Africa when no coordinates captured yet
const DEFAULT_CENTER: [number, number] = [-32.252, 24.531];
const DEFAULT_ZOOM = 7;

function createMarkerIcon(label: string, variant: "start" | "waypoint" | "end"): L.DivIcon {
  const bg =
    variant === "start"
      ? "#15803d"
      : variant === "end"
        ? "#b91c1c"
        : "#1d4ed8";
  return L.divIcon({
    className: "worktrack-route-marker",
    html: `<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background:${bg};color:#ffffff;font-weight:700;font-size:12px;border:2px solid #ffffff;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function createSegmentLabelIcon(text: string): L.DivIcon {
  return L.divIcon({
    className: "worktrack-segment-label",
    html: `<div style="display:inline-block;white-space:nowrap;padding:1px 6px;border-radius:9999px;background:rgba(15,23,42,0.86);color:#ffffff;font-size:11px;font-weight:600;border:1px solid rgba(255,255,255,0.6);">${text}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

export default function RouteMapCanvas({
  points,
  editable,
  insertAfterIndex,
  onMapClickAdd,
  onMarkerDragMove,
}: RouteMapCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<L.Map | null>(null);
  const layerGroupRef = React.useRef<L.LayerGroup | null>(null);
  const fittedCountRef = React.useRef<number>(0);

  const onMapClickRef = React.useRef(onMapClickAdd);
  const editableRef = React.useRef(editable);
  const onMarkerDragRef = React.useRef(onMarkerDragMove);

  React.useEffect(() => {
    onMapClickRef.current = onMapClickAdd;
    editableRef.current = editable;
    onMarkerDragRef.current = onMarkerDragMove;
  }, [onMapClickAdd, editable, onMarkerDragMove]);

  // Initialize Leaflet map once on client
  React.useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (!editableRef.current || !onMapClickRef.current) return;
      onMapClickRef.current(
        Number(e.latlng.lat.toFixed(6)),
        Number(e.latlng.lng.toFixed(6)),
      );
    });

    mapRef.current = map;
    layerGroupRef.current = group;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  // Sync markers, polyline, and segment distance labels
  React.useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();
    const ordered = [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const metrics = calculateRouteMetrics(ordered);

    if (ordered.length >= 2) {
      const latLngs: [number, number][] = ordered.map((p) => [p.latitude, p.longitude]);
      L.polyline(latLngs, {
        color: "#2563eb",
        weight: 4,
        opacity: 0.9,
      }).addTo(group);

      // Midpoint distance labels for each consecutive segment
      for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i]!;
        const b = ordered[i + 1]!;
        const segDist = metrics.segmentDistancesMeters[i] ?? 0;
        const midLat = (a.latitude + b.latitude) / 2;
        const midLng = (a.longitude + b.longitude) / 2;
        L.marker([midLat, midLng], {
          icon: createSegmentLabelIcon(formatDistanceMeters(segDist)),
          interactive: false,
        }).addTo(group);
      }
    }

    let waypointNum = 0;
    ordered.forEach((pt, idx) => {
      let badgeLabel = "S";
      let title = "Start of road";
      if (pt.pointType === "waypoint") {
        waypointNum += 1;
        badgeLabel = String(waypointNum);
        title = `Waypoint ${waypointNum}`;
      } else if (pt.pointType === "end") {
        badgeLabel = "E";
        title = "End of road";
      }

      const cum = metrics.cumulativeDistancesMeters[idx] ?? 0;
      const seg = idx > 0 ? (metrics.segmentDistancesMeters[idx - 1] ?? 0) : 0;
      const marker = L.marker([pt.latitude, pt.longitude], {
        icon: createMarkerIcon(badgeLabel, pt.pointType),
        draggable: editable,
        title,
      }).addTo(group);

      marker.bindPopup(
        `<div style="font-size:12px;line-height:1.4;">
          <strong>${title}</strong><br/>
          Cumulative: <strong>${formatDistanceMeters(cum)}</strong><br/>
          ${idx > 0 ? `From previous: ${formatDistanceMeters(seg)}<br/>` : ""}
          Coords: ${pt.latitude.toFixed(6)}, ${pt.longitude.toFixed(6)}<br/>
          Method: ${pt.captureMethod === "gps" ? "GPS" : "Manual map"}${
            pt.gpsAccuracyMeters !== null ? ` (±${Math.round(pt.gpsAccuracyMeters)} m)` : ""
          }
        </div>`,
      );

      if (editable) {
        marker.on("dragend", () => {
          const pos = marker.getLatLng();
          onMarkerDragRef.current?.(
            pt.id,
            Number(pos.lat.toFixed(6)),
            Number(pos.lng.toFixed(6)),
          );
        });
      }
    });

    // Fit map bounds when points are first populated or count increases significantly
    if (ordered.length > 0 && fittedCountRef.current === 0) {
      fittedCountRef.current = ordered.length;
      if (ordered.length === 1) {
        map.setView([ordered[0]!.latitude, ordered[0]!.longitude], 15, { animate: false });
      } else {
        const bounds = L.latLngBounds(ordered.map((p) => [p.latitude, p.longitude] as [number, number]));
        map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16, animate: false });
      }
    }
  }, [points, editable]);

  return (
    <div className="space-y-1.5">
      <div
        ref={containerRef}
        className="h-72 w-full rounded-md border border-border bg-muted/30 sm:h-80"
        aria-label="Interactive road route map"
      />
      <p className="text-xs text-muted-foreground">
        {editable
          ? insertAfterIndex !== null
            ? `Insert mode active: tap or click the map to insert a new waypoint after point #${insertAfterIndex + 1}.`
            : "Tip: Tap or click anywhere on the map to place a point, or drag any marker to adjust its position."
          : "Read-only route map. Authorised Admin users can amend the route via Scope Amendment."}
      </p>
    </div>
  );
}