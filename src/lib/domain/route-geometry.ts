import type {
  GpsPoint,
  RouteCaptureMethod,
  RoutePoint,
  RoutePointType,
} from "@/lib/domain/assessment-types";
import { mergeIntervalLength } from "@/lib/domain/assessment-calc";

// WGS-84 ellipsoid constants
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const EARTH_MEAN_RADIUS_M = 6371008.8;

export const POOR_GPS_ACCURACY_THRESHOLD_METERS = 25;
export const DUPLICATE_POINT_THRESHOLD_METERS = 1.0;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_MEAN_RADIUS_M * c;
}

/**
 * Full-precision geodesic distance in metres between two WGS-84 coordinates
 * using Vincenty's inverse formula with Haversine fallback for antipodal points.
 */
export function geodesicDistanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  if (a.latitude === b.latitude && a.longitude === b.longitude) return 0;

  const phi1 = toRad(a.latitude);
  const phi2 = toRad(b.latitude);
  const L = toRad(b.longitude - a.longitude);

  const U1 = Math.atan((1 - WGS84_F) * Math.tan(phi1));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(phi2));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let iterLimit = 100;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;

  while (iterLimit-- > 0) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    const lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - lambdaPrev) < 1e-12) break;
  }

  if (iterLimit <= 0) {
    return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
  }

  const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  return WGS84_B * A * (sigma - deltaSigma);
}

export function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "0 m";
  if (meters < 1000) {
    return meters < 100 ? `${meters.toFixed(1)} m` : `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

export function isPoorGpsAccuracy(accuracyMeters: number | null): boolean {
  return accuracyMeters !== null && accuracyMeters > POOR_GPS_ACCURACY_THRESHOLD_METERS;
}

export interface RouteMetrics {
  totalDistanceMeters: number;
  segmentDistancesMeters: number[];
  cumulativeDistancesMeters: number[];
  pointCount: number;
  waypointCount: number;
  hasStart: boolean;
  hasEnd: boolean;
  isComplete: boolean;
}

/**
 * Normalise route point sequence numbers (0..n-1) and enforce canonical start/waypoint/end typing.
 * Preserves incomplete routes (e.g. start + waypoints without an end point yet).
 */
export function resequenceRoutePoints(points: RoutePoint[], preserveOpenEnd = false): RoutePoint[] {
  const sorted = [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const hasExplicitEnd = sorted.some((p) => p.pointType === "end");
  return sorted.map((pt, idx) => {
    let pointType: RoutePointType = pt.pointType;
    if (idx === 0) {
      pointType = "start";
    } else if (!preserveOpenEnd && hasExplicitEnd && idx === sorted.length - 1) {
      pointType = "end";
    } else if (pt.pointType === "start" && idx > 0) {
      pointType = "waypoint";
    } else if (pt.pointType === "end" && idx < sorted.length - 1) {
      pointType = "waypoint";
    }
    return { ...pt, sequenceNumber: idx, pointType };
  });
}

/**
 * Backward-compatibility adapter: if an existing assessment has only legacy startGps / endGps
 * and no routePoints yet, derive RoutePoint[] without losing any data.
 */
export function hydrateRoutePoints(
  routePoints: RoutePoint[] | undefined,
  startGps: GpsPoint | null,
  endGps: GpsPoint | null,
  createdByEmail = "",
): RoutePoint[] {
  if (routePoints && routePoints.length > 0) {
    return resequenceRoutePoints(routePoints);
  }
  const derived: RoutePoint[] = [];
  if (startGps) {
    derived.push({
      id: "legacy-start",
      clientPointId: "legacy-start",
      pointType: "start",
      sequenceNumber: 0,
      latitude: startGps.lat,
      longitude: startGps.lng,
      gpsAccuracyMeters: startGps.accuracyMeters,
      capturedAt: startGps.capturedAt,
      capturedByUserId: null,
      capturedByEmail: createdByEmail,
      captureMethod: "gps",
    });
  }
  if (endGps) {
    derived.push({
      id: "legacy-end",
      clientPointId: "legacy-end",
      pointType: "end",
      sequenceNumber: derived.length,
      latitude: endGps.lat,
      longitude: endGps.lng,
      gpsAccuracyMeters: endGps.accuracyMeters,
      capturedAt: endGps.capturedAt,
      capturedByUserId: null,
      capturedByEmail: createdByEmail,
      captureMethod: "gps",
    });
  }
  return derived;
}

export function extractStartEndGps(points: RoutePoint[]): {
  startGps: GpsPoint | null;
  endGps: GpsPoint | null;
} {
  const start = points.find((p) => p.pointType === "start") ?? null;
  const end = points.find((p) => p.pointType === "end") ?? null;
  return {
    startGps: start
      ? {
          lat: start.latitude,
          lng: start.longitude,
          accuracyMeters: start.gpsAccuracyMeters,
          capturedAt: start.capturedAt,
        }
      : null,
    endGps: end
      ? {
          lat: end.latitude,
          lng: end.longitude,
          accuracyMeters: end.gpsAccuracyMeters,
          capturedAt: end.capturedAt,
        }
      : null,
  };
}

/**
 * Calculate full-precision geodesic segment distances and cumulative distance from start.
 */
export function calculateRouteMetrics(points: RoutePoint[]): RouteMetrics {
  const ordered = [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const segmentDistancesMeters: number[] = [];
  const cumulativeDistancesMeters: number[] = [];
  let total = 0;

  for (let i = 0; i < ordered.length; i++) {
    if (i === 0) {
      cumulativeDistancesMeters.push(0);
    } else {
      const seg = geodesicDistanceMeters(ordered[i - 1]!, ordered[i]!);
      segmentDistancesMeters.push(seg);
      total += seg;
      cumulativeDistancesMeters.push(total);
    }
  }

  const hasStart = ordered.some((p) => p.pointType === "start");
  const hasEnd = ordered.some((p) => p.pointType === "end");
  const waypointCount = ordered.filter((p) => p.pointType === "waypoint").length;

  return {
    totalDistanceMeters: total,
    segmentDistancesMeters,
    cumulativeDistancesMeters,
    pointCount: ordered.length,
    waypointCount,
    hasStart,
    hasEnd,
    isComplete: hasStart && hasEnd && ordered.length >= 2,
  };
}

export interface ProximityCheckResult {
  isDuplicate: boolean;
  warning: string | null;
  distanceToPreviousMeters: number | null;
}

/**
 * Check whether a new point is an accidental duplicate or unusually close relative to GPS accuracy.
 * Never silently discards points — returns explicit block/warning feedback for the UI.
 */
export function checkPointProximity(
  existingPoints: RoutePoint[],
  latitude: number,
  longitude: number,
  accuracyMeters: number | null,
): ProximityCheckResult {
  if (existingPoints.length === 0) {
    return { isDuplicate: false, warning: null, distanceToPreviousMeters: null };
  }
  const ordered = [...existingPoints].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const prev = ordered[ordered.length - 1]!;
  const dist = geodesicDistanceMeters(prev, { latitude, longitude });

  if (dist < DUPLICATE_POINT_THRESHOLD_METERS) {
    return {
      isDuplicate: true,
      warning: `This point is only ${dist.toFixed(1)} m from the previous point and looks like a duplicate.`,
      distanceToPreviousMeters: dist,
    };
  }

  const accuracyFloor = Math.max(15, (accuracyMeters ?? prev.gpsAccuracyMeters ?? 10) * 1.5);
  if (dist < accuracyFloor) {
    return {
      isDuplicate: false,
      warning: `Point is ${dist.toFixed(1)} m from the previous point, which is close relative to GPS accuracy (±${Math.round(accuracyMeters ?? prev.gpsAccuracyMeters ?? 10)} m). Keep or undo if accidental.`,
      distanceToPreviousMeters: dist,
    };
  }

  return { isDuplicate: false, warning: null, distanceToPreviousMeters: dist };
}

export function insertRoutePointAt(
  points: RoutePoint[],
  insertIndex: number,
  newPoint: Omit<RoutePoint, "sequenceNumber">,
): RoutePoint[] {
  const ordered = [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const clamped = Math.max(0, Math.min(insertIndex, ordered.length));
  const next = [
    ...ordered.slice(0, clamped),
    { ...newPoint, sequenceNumber: clamped },
    ...ordered.slice(clamped),
  ];
  return next.map((pt, idx) => ({ ...pt, sequenceNumber: idx }));
}

export function moveRoutePoint(
  points: RoutePoint[],
  pointId: string,
  latitude: number,
  longitude: number,
  captureMethod: RouteCaptureMethod = "manual_map",
): RoutePoint[] {
  return points.map((pt) =>
    pt.id === pointId
      ? {
          ...pt,
          latitude,
          longitude,
          captureMethod,
          gpsAccuracyMeters: captureMethod === "manual_map" ? null : pt.gpsAccuracyMeters,
        }
      : pt,
  );
}

export function deleteRoutePoint(points: RoutePoint[], pointId: string): RoutePoint[] {
  const remaining = points
    .filter((pt) => pt.id !== pointId)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return resequenceRoutePoints(remaining);
}

export function reorderRoutePoint(
  points: RoutePoint[],
  fromIndex: number,
  toIndex: number,
): RoutePoint[] {
  const ordered = [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (
    fromIndex < 0 ||
    fromIndex >= ordered.length ||
    toIndex < 0 ||
    toIndex >= ordered.length ||
    fromIndex === toIndex
  ) {
    return ordered;
  }
  const moved = ordered[fromIndex]!;
  const without = ordered.filter((_, i) => i !== fromIndex);
  without.splice(toIndex, 0, moved);
  // Preserve start at index 0 and end at last index when present
  const hadEnd = ordered.some((p) => p.pointType === "end");
  return without.map((pt, idx) => ({
    ...pt,
    sequenceNumber: idx,
    pointType:
      idx === 0
        ? "start"
        : hadEnd && idx === without.length - 1
          ? "end"
          : "waypoint",
  }));
}

export function undoLastRoutePoint(points: RoutePoint[]): RoutePoint[] {
  if (points.length === 0) return [];
  const ordered = [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return ordered.slice(0, -1).map((pt, idx) => ({ ...pt, sequenceNumber: idx }));
}

export interface RouteProjection {
  distanceFromStartMeters: number;
  offsetMeters: number;
  segmentIndex: number;
  totalRouteMeters: number;
}

/**
 * Project any geographic coordinate onto the measured multi-waypoint road polyline.
 * Establishes the chainage distance from the route start for weekly progress reporting
 * along the actual shape of the road.
 */
export function projectPointOntoRoute(
  points: RoutePoint[],
  latitude: number,
  longitude: number,
): RouteProjection | null {
  const ordered = [...points].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (ordered.length < 2) return null;

  const metrics = calculateRouteMetrics(ordered);
  let bestDistFromStart = 0;
  let bestOffset = Number.POSITIVE_INFINITY;
  let bestSegIdx = 0;

  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    const segLen = metrics.segmentDistancesMeters[i] ?? 0;
    const cumStart = metrics.cumulativeDistancesMeters[i] ?? 0;

    // Local tangent-plane projection (metres) around segment midpoint for accurate clamping
    const midLatRad = toRad((a.latitude + b.latitude) / 2);
    const mPerDegLat = 111132.92;
    const mPerDegLng = 111412.84 * Math.cos(midLatRad);

    const ax = 0;
    const ay = 0;
    const bx = (b.longitude - a.longitude) * mPerDegLng;
    const by = (b.latitude - a.latitude) * mPerDegLat;
    const px = (longitude - a.longitude) * mPerDegLng;
    const py = (latitude - a.latitude) * mPerDegLat;

    const abSq = bx * bx + by * by;
    const t = abSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / abSq)) : 0;
    const projLat = a.latitude + t * (b.latitude - a.latitude);
    const projLng = a.longitude + t * (b.longitude - a.longitude);
    const offset = geodesicDistanceMeters(
      { latitude, longitude },
      { latitude: projLat, longitude: projLng },
    );

    if (offset < bestOffset) {
      bestOffset = offset;
      bestSegIdx = i;
      bestDistFromStart = cumStart + t * segLen;
    }
  }

  return {
    distanceFromStartMeters: bestDistFromStart,
    offsetMeters: bestOffset,
    segmentIndex: bestSegIdx,
    totalRouteMeters: metrics.totalDistanceMeters,
  };
}

/**
 * Merge completed progress intervals along the route so overlapping completed sections
 * are never counted twice.
 */
export function mergeCompletedRouteIntervals(
  intervals: Array<[number, number]>,
  totalRouteMeters?: number,
): number {
  const clamped: Array<[number, number]> = intervals.map(([s, e]) => {
    const lo = Math.max(0, Math.min(s, e));
    const hi = totalRouteMeters !== undefined ? Math.min(totalRouteMeters, Math.max(s, e)) : Math.max(s, e);
    return [lo, hi];
  });
  return mergeIntervalLength(clamped);
}