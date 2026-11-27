import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  calculateRouteMetrics,
  checkPointProximity,
  deleteRoutePoint,
  formatDistanceMeters,
  geodesicDistanceMeters,
  hydrateRoutePoints,
  insertRoutePointAt,
  isPoorGpsAccuracy,
  mergeCompletedRouteIntervals,
  moveRoutePoint,
  projectPointOntoRoute,
  reorderRoutePoint,
  undoLastRoutePoint,
} from "@/lib/domain/route-geometry";
import { calculateAssessmentSizing } from "@/lib/domain/assessment-calc";
import {
  approveAssessmentScope,
  listAssessmentsAndBenchmarks,
  saveAssessmentDraft,
  syncOfflineWaypoints,
} from "@/lib/data/assessment-repository";
import {
  clearOfflineWaypointsForAssessment,
  enqueueOfflineWaypoint,
  getOfflineWaypoints,
} from "@/lib/data/offline-waypoint-queue";
import { SYNTHETIC_BIZ_A } from "@/lib/data/synthetic-fixtures";
import type { RoutePoint, SiteAssessment } from "@/lib/domain/assessment-types";
import type { AuthSession } from "@/lib/domain/types";

const adminSession: AuthSession = {
  userId: "u-admin-a",
  email: "admin@synthetic.worktrack.local",
  fullName: "Admin",
  businessId: SYNTHETIC_BIZ_A,
  businessName: "Biz A",
  role: "admin",
  assignedJobIds: [],
  mode: "synthetic_dev",
};

const ownerSession: AuthSession = {
  ...adminSession,
  userId: "u-owner-a",
  email: "owner@synthetic.worktrack.local",
  role: "owner",
};

function makePt(
  id: string,
  type: RoutePoint["pointType"],
  seq: number,
  lat: number,
  lng: number,
  accuracy: number | null = 8,
  method: RoutePoint["captureMethod"] = "gps",
): RoutePoint {
  return {
    id,
    clientPointId: id,
    pointType: type,
    sequenceNumber: seq,
    latitude: lat,
    longitude: lng,
    gpsAccuracyMeters: accuracy,
    capturedAt: "2026-11-27T10:00:00.000Z",
    capturedByUserId: ownerSession.userId,
    capturedByEmail: ownerSession.email,
    captureMethod: method,
  };
}

function makeBaseDraft(overrides: Partial<SiteAssessment> = {}) {
  return {
    jobId: null,
    name: "Multi-waypoint R63 Test",
    customerName: "Synthetic Roads",
    roadOrArea: "R63 Bend Section",
    directionDescription: "North to East",
    status: "draft" as const,
    revision: 1,
    startGps: null,
    endGps: null,
    gpsUnavailableReason: null,
    distanceSource: "gps_route" as const,
    originalDistanceMeters: 5000,
    acceptedDistanceMeters: 5000,
    distanceOverrideReason: null,
    distanceProvisional: false,
    sections: [
      {
        id: "sec-1",
        label: "Section 1",
        startChainageMeters: 0,
        endChainageMeters: 5000,
        carriageway: "single" as const,
        strips: [
          { id: "l", side: "left" as const, widthMeters: 5, lengthOverrideMeters: null },
          { id: "r", side: "right" as const, widthMeters: 5, lengthOverrideMeters: null },
        ],
        difficulty: "similar" as const,
        difficultyReasons: [],
        activities: ["cutting" as const],
        notes: "",
      },
    ],
    exclusions: "",
    benchmarkId: "bm-illustrative-1",
    benchmarkProductivitySqm: 250,
    benchmarkConfidence: "illustrative_assumption" as const,
    productiveCrewSize: 12,
    roadWorkerDailyRateCents: 25000,
    cookWeeklyRateCents: 50000,
    includeCook: true,
    workdaysPerWeek: 5,
    contractValueCents: 25000000,
    budgetLines: [
      { id: "bl-1", category: "fuel" as const, label: "Fuel", amountCents: 1500000, classification: "operating" as const },
    ],
    reviewComment: null,
    revisions: [],
    ...overrides,
  };
}

describe("Increment B Extension — Multi-waypoint GPS route acceptance tests (1–10)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("1. Existing start-and-end-only assessments remain compatible", async () => {
    const legacy = await saveAssessmentDraft(
      ownerSession,
      makeBaseDraft({
        startGps: { lat: -32.25, lng: 24.53, accuracyMeters: 10, capturedAt: "2026-11-27T09:00:00Z" },
        endGps: { lat: -32.26, lng: 24.53, accuracyMeters: 12, capturedAt: "2026-11-27T09:10:00Z" },
      }),
    );
    expect(legacy.routePoints).toHaveLength(2);
    expect(legacy.routePoints![0]!.pointType).toBe("start");
    expect(legacy.routePoints![1]!.pointType).toBe("end");
    expect(legacy.startGps?.lat).toBe(-32.25);
    expect(legacy.endGps?.lat).toBe(-32.26);

    const hydrated = hydrateRoutePoints(undefined, legacy.startGps, legacy.endGps);
    expect(hydrated).toHaveLength(2);
    expect(calculateRouteMetrics(hydrated).totalDistanceMeters).toBeGreaterThan(1000);
  });

  it("2 & 3. Road with corners sums consecutive geodesic segments (> straight-line distance)", async () => {
    // L-shaped road: 0.01 deg north (~1.11 km) then 0.01 deg east (~0.94 km)
    const pStart = makePt("p0", "start", 0, -32.25, 24.53);
    const pCorner = makePt("p1", "waypoint", 1, -32.24, 24.53);
    const pEnd = makePt("p2", "end", 2, -32.24, 24.54);

    const seg1 = geodesicDistanceMeters(pStart, pCorner);
    const seg2 = geodesicDistanceMeters(pCorner, pEnd);
    const straightLine = geodesicDistanceMeters(pStart, pEnd);
    const metrics = calculateRouteMetrics([pStart, pCorner, pEnd]);

    expect(metrics.segmentDistancesMeters).toHaveLength(2);
    expect(metrics.totalDistanceMeters).toBeCloseTo(seg1 + seg2, 6);
    // L-shape is significantly longer than hypotenuse straight-line
    expect(metrics.totalDistanceMeters).toBeGreaterThan(straightLine + 500);
    expect(metrics.cumulativeDistancesMeters[2]).toBeCloseTo(metrics.totalDistanceMeters, 6);
    expect(formatDistanceMeters(450)).toBe("450 m");
    expect(formatDistanceMeters(metrics.totalDistanceMeters)).toMatch(/km$/);

    // Separate waypoint distance and road-network distance are never conflated
    const saved = await saveAssessmentDraft(
      ownerSession,
      makeBaseDraft({
        routePoints: [pStart, pCorner, pEnd],
        acceptedDistanceMeters: metrics.totalDistanceMeters,
        roadNetworkDistanceMeters: 2250,
      }),
    );
    expect(saved.waypointMeasuredDistanceMeters).toBeCloseTo(metrics.totalDistanceMeters, 6);
    expect(saved.roadNetworkDistanceMeters).toBe(2250);
  });

  it("4 & 5. Adding, moving, inserting, reordering, or deleting waypoints recalculates distance and dependent sizing", () => {
    const initial: RoutePoint[] = [
      makePt("p0", "start", 0, -32.25, 24.53),
      makePt("p1", "end", 1, -32.24, 24.54),
    ];
    const baseDist = calculateRouteMetrics(initial).totalDistanceMeters;

    // Insert corner waypoint between start and end
    const withCorner = insertRoutePointAt(initial, 1, makePt("p-mid", "waypoint", 1, -32.24, 24.53));
    const cornerDist = calculateRouteMetrics(withCorner).totalDistanceMeters;
    expect(cornerDist).toBeGreaterThan(baseDist + 400);

    // Move corner further north -> distance increases again
    const moved = moveRoutePoint(withCorner, "p-mid", -32.23, 24.53, "manual_map");
    const movedDist = calculateRouteMetrics(moved).totalDistanceMeters;
    expect(movedDist).toBeGreaterThan(cornerDist + 1000);

    // Reorder waypoints
    const reordered = reorderRoutePoint(moved, 1, 2);
    expect(reordered[0]!.pointType).toBe("start");
    expect(reordered[reordered.length - 1]!.pointType).toBe("end");

    // Delete corner -> returns to base distance
    const deleted = deleteRoutePoint(moved, "p-mid");
    expect(calculateRouteMetrics(deleted).totalDistanceMeters).toBeCloseTo(baseDist, 6);

    // Undo last point
    expect(undoLastRoutePoint(withCorner)).toHaveLength(2);

    // Dependent sizing and budget update from baseDist -> movedDist
    const calcFor = (distMeters: number) =>
      calculateAssessmentSizing({
        sections: [
          {
            id: "s1",
            label: "S1",
            startChainageMeters: 0,
            endChainageMeters: distMeters,
            carriageway: "single",
            strips: [
              { id: "l", side: "left", widthMeters: 5, lengthOverrideMeters: null },
              { id: "r", side: "right", widthMeters: 5, lengthOverrideMeters: null },
            ],
            difficulty: "harder",
            difficultyReasons: ["thick_grass"],
            activities: ["cutting"],
            notes: "",
          },
        ],
        benchmarkProductivitySqm: 250,
        productiveCrewSize: 12,
        roadWorkerDailyRateCents: 25000,
        cookWeeklyRateCents: 50000,
        includeCook: true,
        workdaysPerWeek: 5,
        contractValueCents: 25000000,
        budgetLines: [],
      });

    const sBefore = calcFor(baseDist);
    const sAfter = calcFor(movedDist);
    expect(sAfter.roadLengthMeters).toBeGreaterThan(sBefore.roadLengthMeters);
    expect(sAfter.vergeLengthMeters).toBeGreaterThan(sBefore.vergeLengthMeters);
    expect(sAfter.physicalAreaSqm).toBeGreaterThan(sBefore.physicalAreaSqm);
    expect(sAfter.effortUnitsSqm).toBeGreaterThan(sBefore.effortUnitsSqm);
    expect(sAfter.estimatedLabourCents).toBeGreaterThan(sBefore.estimatedLabourCents);
    expect(sAfter.estimatedOperatingSurplusCents).toBeLessThan(sBefore.estimatedOperatingSurplusCents);
  });

  it("6 & 8. Incomplete route can be saved, resumed, and persists across session reload", async () => {
    const incompletePoints = [
      makePt("p0", "start", 0, -32.25, 24.53),
      makePt("p1", "waypoint", 1, -32.245, 24.532),
    ];
    const saved = await saveAssessmentDraft(
      ownerSession,
      makeBaseDraft({
        name: "Incomplete Resume Road",
        routePoints: incompletePoints,
        acceptedDistanceMeters: calculateRouteMetrics(incompletePoints).totalDistanceMeters,
      }),
    );
    expect(calculateRouteMetrics(saved.routePoints!).isComplete).toBe(false);

    // Simulate logout/restart by listing fresh from storage as Admin (same business)
    const { assessments } = await listAssessmentsAndBenchmarks(adminSession);
    const reloaded = assessments.find((a) => a.id === saved.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.routePoints).toHaveLength(2);

    // Resume and add end point
    const resumedPoints = [
      ...reloaded!.routePoints!,
      makePt("p2", "end", 2, -32.24, 24.535),
    ];
    const completed = await saveAssessmentDraft(ownerSession, {
      ...reloaded!,
      routePoints: resumedPoints,
      acceptedDistanceMeters: calculateRouteMetrics(resumedPoints).totalDistanceMeters,
    });
    expect(calculateRouteMetrics(completed.routePoints!).isComplete).toBe(true);
    expect(completed.routePoints).toHaveLength(3);
  });

  it("7. Offline waypoint capture syncs without creating duplicate records", async () => {
    const startPt = makePt("offline-start", "start", 0, -32.25, 24.53);
    const saved = await saveAssessmentDraft(
      ownerSession,
      makeBaseDraft({
        routePoints: [startPt],
        acceptedDistanceMeters: 1000,
      }),
    );

    const wp1 = makePt("offline-wp-1", "waypoint", 1, -32.245, 24.53);
    const endPt = makePt("offline-end", "end", 2, -32.24, 24.535);

    // Enqueue twice to simulate retry / duplicate tap while offline
    enqueueOfflineWaypoint(saved.id, ownerSession.businessId, wp1);
    enqueueOfflineWaypoint(saved.id, ownerSession.businessId, wp1);
    enqueueOfflineWaypoint(saved.id, ownerSession.businessId, endPt);
    expect(getOfflineWaypoints(saved.id)).toHaveLength(2);

    // Sync once -> adds 2 points and clears queue
    const firstSync = await syncOfflineWaypoints(ownerSession, saved.id);
    expect(firstSync.syncedCount).toBe(2);
    expect(firstSync.assessment.routePoints).toHaveLength(3);
    expect(getOfflineWaypoints(saved.id)).toHaveLength(0);

    // Re-enqueuing an already-synced clientPointId and syncing again creates 0 duplicates
    enqueueOfflineWaypoint(saved.id, ownerSession.businessId, wp1);
    const replaySync = await syncOfflineWaypoints(ownerSession, saved.id);
    expect(replaySync.syncedCount).toBe(0);
    expect(replaySync.assessment.routePoints).toHaveLength(3);
    clearOfflineWaypointsForAssessment(saved.id);
  });

  it("9. Permissions, approved-route amendment lock, proximity validation, and SQL migration RLS/audit", async () => {
    const pts = [
      makePt("a0", "start", 0, -32.25, 24.53, 8),
      makePt("a1", "waypoint", 1, -32.245, 24.535, 10),
      makePt("a2", "end", 2, -32.24, 24.54, 12),
    ];

    // Duplicate & close-proximity validation + poor accuracy check
    expect(isPoorGpsAccuracy(40)).toBe(true);
    expect(isPoorGpsAccuracy(12)).toBe(false);
    expect(checkPointProximity(pts, -32.24, 24.54, 10).isDuplicate).toBe(true);
    const closeCheck = checkPointProximity(pts, -32.24005, 24.54, 20);
    expect(closeCheck.isDuplicate).toBe(false);
    expect(closeCheck.warning).toMatch(/close relative to GPS accuracy/i);

    const dist = calculateRouteMetrics(pts).totalDistanceMeters;
    const draft = await saveAssessmentDraft(
      ownerSession,
      makeBaseDraft({
        status: "submitted",
        routePoints: pts,
        acceptedDistanceMeters: dist,
        sections: [
          {
            id: "sec-1",
            label: "S1",
            startChainageMeters: 0,
            endChainageMeters: dist,
            carriageway: "single",
            strips: [{ id: "l", side: "left", widthMeters: 5, lengthOverrideMeters: null }],
            difficulty: "similar",
            difficultyReasons: [],
            activities: ["cutting"],
            notes: "",
          },
        ],
      }),
    );

    const rev1 = await approveAssessmentScope(adminSession, draft, "Baseline route approved");
    expect(rev1.revisions[0]!.routePoints).toHaveLength(3);

    // Owner cannot mutate an approved route directly
    await expect(
      saveAssessmentDraft(ownerSession, {
        ...rev1,
        routePoints: [...pts, makePt("a3", "end", 3, -32.23, 24.55)],
      }),
    ).rejects.toThrow(/locked/i);

    // Admin can amend route with mandatory reason, preserving Rev 1 route points
    const extendedPts = [
      ...pts.slice(0, 2),
      makePt("a2-wp", "waypoint", 2, -32.24, 24.54),
      makePt("a3", "end", 3, -32.23, 24.55),
    ];
    const extDist = calculateRouteMetrics(extendedPts).totalDistanceMeters;
    const rev2 = await approveAssessmentScope(
      adminSession,
      {
        ...rev1,
        routePoints: extendedPts,
        acceptedDistanceMeters: extDist,
        sections: [{ ...rev1.sections[0]!, endChainageMeters: extDist }],
      },
      "Extended route by 1.5 km",
    );
    expect(rev2.revision).toBe(2);
    expect(rev2.revisions[0]!.routePoints).toHaveLength(3);
    expect(rev2.revisions[1]!.routePoints).toHaveLength(4);

    // Weekly progress projection onto measured polyline & non-double-counting intervals
    const proj = projectPointOntoRoute(pts, -32.245, 24.535);
    expect(proj).not.toBeNull();
    expect(proj!.offsetMeters).toBeLessThan(1);
    expect(proj!.distanceFromStartMeters).toBeCloseTo(
      calculateRouteMetrics(pts).cumulativeDistancesMeters[1]!,
      1,
    );
    expect(mergeCompletedRouteIntervals([[0, 500], [250, 750]], dist)).toBe(750);

    // SQL migration enforces RLS, audit trigger, unique sequence & idempotency, and no anon grants
    const sql = readFileSync(
      resolve(process.cwd(), "db/migrations/202611270003_increment_b_route_waypoints.sql"),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.assessment_route_points");
    expect(sql).toContain("ALTER TABLE public.assessment_route_points ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("UNIQUE (assessment_id, sequence_number)");
    expect(sql).toContain("UNIQUE (assessment_id, client_point_id)");
    expect(sql).toContain("CREATE TRIGGER trg_audit_assessment_route_points");
    expect(sql).not.toMatch(/GRANT .* ON public\.assessment_route_points TO anon;/);
  });
});