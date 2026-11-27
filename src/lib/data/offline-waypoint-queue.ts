import type { OfflineWaypointQueueItem, RoutePoint } from "@/lib/domain/assessment-types";
import { resequenceRoutePoints } from "@/lib/domain/route-geometry";

const QUEUE_STORAGE_KEY = "worktrack_offline_waypoint_queue_v1";

function readQueue(): OfflineWaypointQueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OfflineWaypointQueueItem[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: OfflineWaypointQueueItem[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(items));
}

/**
 * Enqueue a waypoint captured while offline.
 * Deduplicates by (assessmentId, clientPointId) so repeated saves/retries never create duplicates.
 */
export function enqueueOfflineWaypoint(
  assessmentId: string,
  businessId: string,
  point: RoutePoint,
): OfflineWaypointQueueItem[] {
  const current = readQueue();
  const exists = current.some(
    (item) =>
      item.assessmentId === assessmentId && item.point.clientPointId === point.clientPointId,
  );
  if (exists) return current;
  const next: OfflineWaypointQueueItem[] = [
    ...current,
    {
      assessmentId,
      businessId,
      point,
      queuedAt: new Date().toISOString(),
    },
  ];
  writeQueue(next);
  return next;
}

export function getOfflineWaypoints(assessmentId?: string): OfflineWaypointQueueItem[] {
  const all = readQueue();
  return assessmentId ? all.filter((item) => item.assessmentId === assessmentId) : all;
}

export function clearOfflineWaypointsForAssessment(
  assessmentId: string,
  syncedClientPointIds?: string[],
): void {
  const all = readQueue();
  const next = all.filter((item) => {
    if (item.assessmentId !== assessmentId) return true;
    if (!syncedClientPointIds) return false;
    return !syncedClientPointIds.includes(item.point.clientPointId);
  });
  writeQueue(next);
}

/**
 * Merge persisted points with queued offline points without creating duplicates
 * (idempotent by clientPointId).
 */
export function mergeRoutePointsDeduplicated(
  persistedPoints: RoutePoint[],
  queuedPoints: RoutePoint[],
): RoutePoint[] {
  const seen = new Set(persistedPoints.map((p) => p.clientPointId));
  const merged = [...persistedPoints];
  for (const qp of queuedPoints) {
    if (!seen.has(qp.clientPointId)) {
      seen.add(qp.clientPointId);
      merged.push({ ...qp, sequenceNumber: merged.length });
    }
  }
  return resequenceRoutePoints(merged);
}