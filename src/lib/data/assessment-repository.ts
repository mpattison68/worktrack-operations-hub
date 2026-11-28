import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { SYNTHETIC_BIZ_A } from "@/lib/data/synthetic-fixtures";
import { saveJob } from "@/lib/data/repository";
import { calculateAssessmentSizing, validateAssessmentSections } from "@/lib/domain/assessment-calc";
import type {
  AssessmentRevisionSnapshot,
  BenchmarkProfile,
  RoutePoint,
  SiteAssessment,
} from "@/lib/domain/assessment-types";
import {
  calculateRouteMetrics,
  extractStartEndGps,
  hydrateRoutePoints,
  resequenceRoutePoints,
} from "@/lib/domain/route-geometry";
import {
  clearOfflineWaypointsForAssessment,
  getOfflineWaypoints,
  mergeRoutePointsDeduplicated,
} from "@/lib/data/offline-waypoint-queue";
import type { AuthSession } from "@/lib/domain/types";
import { assertBusinessBoundary, can } from "@/lib/permissions";

const STORAGE_KEY = "worktrack_synthetic_assessments_v1";

interface SyntheticAssessmentStore {
  benchmarks: BenchmarkProfile[];
  assessments: SiteAssessment[];
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `asmt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createInitialAssessments(): SyntheticAssessmentStore {
  const now = "2026-11-27T09:00:00.000Z";
  return {
    benchmarks: [
      {
        id: "bm-illustrative-1",
        businessId: SYNTHETIC_BIZ_A,
        name: "Illustrative planning assumption (250 m²/worker-day)",
        productivitySqmPerWorkerDay: 250,
        confidence: "illustrative_assumption",
        sourceNote:
          "Temporary illustrative assumption per spec Section 6 — not verified historical actuals.",
        version: 1,
      },
    ],
    assessments: [
      {
        id: "asmt-syn-1",
        businessId: SYNTHETIC_BIZ_A,
        jobId: null,
        name: "Synthetic R75 Corridor Assessment",
        customerName: "Synthetic Provincial Roads",
        roadOrArea: "R75 km 0.0 to km 10.0 (Synthetic)",
        directionDescription: "Northbound from km 0.0 to km 10.0",
        status: "submitted",
        revision: 1,
        startGps: null,
        endGps: null,
        gpsUnavailableReason: "Synthetic fixture — manual chainage used",
        distanceSource: "manual_chainage",
        originalDistanceMeters: 10000,
        acceptedDistanceMeters: 10000,
        distanceOverrideReason: null,
        distanceProvisional: false,
        sections: [
          {
            id: "sec-1",
            label: "Section 1 (Full route)",
            startChainageMeters: 0,
            endChainageMeters: 10000,
            carriageway: "single",
            strips: [
              { id: "st-1", side: "left", widthMeters: 5, lengthOverrideMeters: null },
              { id: "st-2", side: "right", widthMeters: 5, lengthOverrideMeters: null },
            ],
            difficulty: "harder",
            difficultyReasons: ["thick_grass", "bushes"],
            activities: ["cutting", "waste_collection"],
            notes: "Synthetic submitted assessment ready for Admin review.",
          },
        ],
        exclusions: "Culvert concrete structures excluded.",
        benchmarkId: "bm-illustrative-1",
        benchmarkProductivitySqm: 250,
        benchmarkConfidence: "illustrative_assumption",
        productiveCrewSize: 12,
        roadWorkerDailyRateCents: 25000,
        cookWeeklyRateCents: 50000,
        includeCook: true,
        workdaysPerWeek: 5,
        contractValueCents: 44000000,
        budgetLines: [
          { id: "bl-1", category: "fuel", label: "Truck & brush-cutter fuel (est.)", amountCents: 3200000, classification: "operating" },
          { id: "bl-2", category: "food", label: "Crew food & water (est.)", amountCents: 1800000, classification: "operating" },
          { id: "bl-3", category: "safety", label: "PPE & road signage", amountCents: 850000, classification: "operating" },
        ],
        reviewComment: null,
        revisions: [],
        createdByEmail: "owner@synthetic.worktrack.local",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function loadStore(): SyntheticAssessmentStore {
  if (typeof window === "undefined") return createInitialAssessments();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const init = createInitialAssessments();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(init));
      return init;
    }
    const parsed = JSON.parse(raw) as SyntheticAssessmentStore;
    return {
      benchmarks: parsed.benchmarks ?? [],
      assessments: (parsed.assessments ?? []).map((a) => {
        const routePoints = hydrateRoutePoints(
          a.routePoints,
          a.startGps,
          a.endGps,
          a.createdByEmail,
        );
        const metrics = calculateRouteMetrics(routePoints);
        return {
          ...a,
          routePoints,
          waypointMeasuredDistanceMeters:
            a.waypointMeasuredDistanceMeters ??
            (routePoints.length >= 2 ? metrics.totalDistanceMeters : null),
          roadNetworkDistanceMeters: a.roadNetworkDistanceMeters ?? null,
        };
      }),
    };
  } catch {
    return createInitialAssessments();
  }
}

function saveStore(store: SyntheticAssessmentStore): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export async function listAssessmentsAndBenchmarks(
  session: AuthSession,
): Promise<{ assessments: SiteAssessment[]; benchmarks: BenchmarkProfile[] }> {
  if (isSupabaseConfigured && supabase) {
    const [{ data: bmData, error: bmErr }, { data: asData, error: asErr }] = await Promise.all([
      supabase.from("benchmarks").select("*").eq("business_id", session.businessId),
      supabase
        .from("assessments")
        .select("*")
        .eq("business_id", session.businessId)
        .order("updated_at", { ascending: false }),
    ]);
    if (bmErr) throw new Error(bmErr.message);
    if (asErr) throw new Error(asErr.message);
    return {
      benchmarks: (bmData ?? []).map((b) => ({
        id: b.id,
        businessId: b.business_id,
        name: b.name,
        productivitySqmPerWorkerDay: Number(b.productivity_sqm_per_worker_day),
        confidence: b.confidence,
        sourceNote: b.source_note ?? "",
        version: b.version,
      })),
      assessments: (asData ?? []).map((a) => ({
        id: a.id,
        editVersion:Number(a.edit_version??1),
        businessId: a.business_id,
        jobId: a.job_id,
        name: a.name,
        customerName: a.customer_name,
        roadOrArea: a.road_or_area,
        directionDescription: a.direction_description ?? "",
        status: a.status,
        revision: a.revision,
        startGps: a.start_gps,
        endGps: a.end_gps,
        routePoints: hydrateRoutePoints(
          (a.route_points_json as RoutePoint[] | null) ?? undefined,
          a.start_gps,
          a.end_gps,
          a.created_by_email ?? "",
        ),
        waypointMeasuredDistanceMeters:
          a.waypoint_measured_distance_meters !== null &&
          a.waypoint_measured_distance_meters !== undefined
            ? Number(a.waypoint_measured_distance_meters)
            : null,
        roadNetworkDistanceMeters:
          a.road_network_distance_meters !== null &&
          a.road_network_distance_meters !== undefined
            ? Number(a.road_network_distance_meters)
            : null,
        gpsUnavailableReason: a.gps_unavailable_reason,
        distanceSource: a.distance_source,
        originalDistanceMeters: Number(a.original_distance_meters),
        acceptedDistanceMeters: Number(a.accepted_distance_meters),
        distanceOverrideReason: a.distance_override_reason,
        distanceProvisional: a.distance_provisional,
        sections: a.sections_json ?? [],
        exclusions: a.exclusions ?? "",
        benchmarkId: a.benchmark_id ?? "",
        benchmarkProductivitySqm: Number(a.benchmark_productivity_sqm),
        benchmarkConfidence: a.benchmark_confidence,
        productiveCrewSize: a.productive_crew_size,
        roadWorkerDailyRateCents: Number(a.road_worker_daily_rate_cents),
        cookWeeklyRateCents: Number(a.cook_weekly_rate_cents),
        includeCook: a.include_cook,
        workdaysPerWeek: a.workdays_per_week,
        contractValueCents: Number(a.contract_value_cents),
        budgetLines: a.budget_lines_json ?? [],
        reviewComment: a.review_comment,
        revisions: a.revisions_json ?? [],
        createdByEmail: a.created_by_email ?? "",
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    };
  }

  const store = loadStore();
  return {
    benchmarks: store.benchmarks.filter((b) => b.businessId === session.businessId),
    assessments: store.assessments.filter((a) => a.businessId === session.businessId),
  };
}

export async function saveAssessmentDraft(
  session: AuthSession,
  input: Omit<SiteAssessment, "id" | "businessId" | "createdAt" | "updatedAt" | "createdByEmail"> & {
    id?: string;
    idempotencyKey?: string;
  },
): Promise<SiteAssessment> {
  if (!can(session.role, "assessments.create")) {
    throw new Error("Access denied: you cannot create or edit site assessments.");
  }
  if (!input.name.trim()) throw new Error("Job or road name is required.");
  if (!input.roadOrArea.trim()) throw new Error("Road or area is required.");
  if (input.acceptedDistanceMeters <= 0 && input.status !== "draft") {
    throw new Error("Road distance must be greater than 0 metres.");
  }
  const sectionErrors = validateAssessmentSections(input.sections);
  if (sectionErrors.length > 0 && input.status !== "draft") {
    throw new Error(sectionErrors[0]!);
  }

  const normalizedRoutePoints = input.routePoints?.length
    ? resequenceRoutePoints(input.routePoints, !input.routePoints.some((p) => p.pointType === "end"))
    : hydrateRoutePoints(undefined, input.startGps, input.endGps, session.email);
  const derivedStartEnd = normalizedRoutePoints.length
    ? extractStartEndGps(normalizedRoutePoints)
    : { startGps: input.startGps, endGps: input.endGps };
  const routeMetrics = calculateRouteMetrics(normalizedRoutePoints);
  const waypointMeasuredDistanceMeters =
    normalizedRoutePoints.length >= 2
      ? routeMetrics.totalDistanceMeters
      : (input.waypointMeasuredDistanceMeters ?? null);
  const roadNetworkDistanceMeters = input.roadNetworkDistanceMeters ?? null;

  const now = new Date().toISOString();

  if (isSupabaseConfigured && supabase) {
    const payload = {
      business_id: session.businessId,
      job_id: input.jobId,
      name: input.name.trim(),
      customer_name: input.customerName.trim(),
      road_or_area: input.roadOrArea.trim(),
      direction_description: input.directionDescription.trim(),
      status: input.status,
      revision: input.revision,
      start_gps: derivedStartEnd.startGps,
      end_gps: derivedStartEnd.endGps,
      route_points_json: normalizedRoutePoints,
      waypoint_measured_distance_meters: waypointMeasuredDistanceMeters,
      road_network_distance_meters: roadNetworkDistanceMeters,
      gps_unavailable_reason: input.gpsUnavailableReason,
      distance_source: input.distanceSource,
      original_distance_meters: input.originalDistanceMeters,
      accepted_distance_meters: input.acceptedDistanceMeters,
      distance_override_reason: input.distanceOverrideReason,
      distance_provisional: input.distanceProvisional,
      sections_json: input.sections,
      exclusions: input.exclusions.trim(),
      benchmark_id: input.benchmarkId || null,
      benchmark_productivity_sqm: input.benchmarkProductivitySqm,
      benchmark_confidence: input.benchmarkConfidence,
      productive_crew_size: input.productiveCrewSize,
      road_worker_daily_rate_cents: input.roadWorkerDailyRateCents,
      cook_weekly_rate_cents: input.cookWeeklyRateCents,
      include_cook: input.includeCook,
      workdays_per_week: input.workdaysPerWeek,
      contract_value_cents: input.contractValueCents,
      budget_lines_json: input.budgetLines,
      review_comment: input.reviewComment,
      revisions_json: input.revisions,
    };
    const {data: epochRow,error:epochError}=await supabase.from('businesses').select('data_epoch').eq('id',session.businessId).single();
    if(epochError)throw new Error(epochError.message);
    const {data: result,error}=await supabase.rpc('worktrack_save_assessment',{p_business:session.businessId,p_epoch:epochRow.data_epoch,p_payload:{...payload,...(input.id?{id:input.id}:{})},p_expected_version:input.editVersion??0,p_key:input.idempotencyKey??crypto.randomUUID()});
    if(error)throw new Error(error.message);
    if(result.status==='conflict')throw Object.assign(new Error('Assessment changed on another device. Refresh and review before saving.'),{conflictData:result});
    const data=result.record;

    return {
      ...input,
      id: data.id,
      editVersion:Number(data.edit_version??1),
      businessId: data.business_id,
      startGps: derivedStartEnd.startGps,
      endGps: derivedStartEnd.endGps,
      routePoints: normalizedRoutePoints,
      waypointMeasuredDistanceMeters,
      roadNetworkDistanceMeters,
      createdByEmail: data.created_by_email ?? session.email,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  const store = loadStore();
  if (input.id) {
    const idx = store.assessments.findIndex((a) => a.id === input.id);
    if (idx < 0) throw new Error("Assessment not found.");
    const existing = store.assessments[idx]!;
    assertBusinessBoundary(session, existing.businessId, "assessment");
    if (existing.status === "approved" && !can(session.role, "scope.approve")) {
      throw new Error("Approved scope is locked. Only Management / Admin can create a scope amendment.");
    }
    const updated: SiteAssessment = {
      ...existing,
      ...input,
      id: existing.id,
      businessId: existing.businessId,
      startGps: derivedStartEnd.startGps,
      endGps: derivedStartEnd.endGps,
      routePoints: normalizedRoutePoints,
      waypointMeasuredDistanceMeters,
      roadNetworkDistanceMeters,
      updatedAt: now,
    };
    store.assessments[idx] = updated;
    saveStore(store);
    return updated;
  }

  const created: SiteAssessment = {
    ...input,
    id: newId(),
    businessId: session.businessId,
    startGps: derivedStartEnd.startGps,
    endGps: derivedStartEnd.endGps,
    routePoints: normalizedRoutePoints,
    waypointMeasuredDistanceMeters,
    roadNetworkDistanceMeters,
    createdByEmail: session.email,
    createdAt: now,
    updatedAt: now,
  };
  store.assessments.unshift(created);
  saveStore(store);
  return created;
}

/**
 * Synchronise offline-captured waypoints for an assessment without creating duplicate records.
 * Deduplicates using clientPointId and recalculates waypoint distance and dependent single-section sizing.
 */
export async function syncOfflineWaypoints(
  session: AuthSession,
  assessmentId: string,
): Promise<{ assessment: SiteAssessment; syncedCount: number }> {
  const queued = getOfflineWaypoints(assessmentId);
  if(session.mode==='supabase')throw new Error('Legacy unpartitioned waypoints are not uploaded. Save the full assessment using the protected offline queue.');
  const { assessments } = await listAssessmentsAndBenchmarks(session);
  const target = assessments.find((a) => a.id === assessmentId);
  if (!target) throw new Error("Assessment not found.");
  assertBusinessBoundary(session, target.businessId, "assessment");

  if (queued.length === 0) {
    return { assessment: target, syncedCount: 0 };
  }

  const existingPoints = target.routePoints ?? [];
  const existingIds = new Set(existingPoints.map((p) => p.clientPointId));
  const newCount = queued.filter((q) => !existingIds.has(q.point.clientPointId)).length;

  const mergedPoints = mergeRoutePointsDeduplicated(
    existingPoints,
    queued.map((q) => q.point),
  );
  const metrics = calculateRouteMetrics(mergedPoints);
  const useMeasured =
    target.distanceSource === "gps_route" &&
    !target.distanceOverrideReason &&
    metrics.totalDistanceMeters > 0;
  const nextAccepted = useMeasured ? metrics.totalDistanceMeters : target.acceptedDistanceMeters;
  const nextSections =
    useMeasured && target.sections.length === 1
      ? [
          {
            ...target.sections[0]!,
            startChainageMeters: 0,
            endChainageMeters: nextAccepted,
          },
        ]
      : target.sections;

  const saved = await saveAssessmentDraft(session, {
    ...target,
    routePoints: mergedPoints,
    waypointMeasuredDistanceMeters:
      mergedPoints.length >= 2 ? metrics.totalDistanceMeters : null,
    originalDistanceMeters:
      metrics.totalDistanceMeters > 0 ? metrics.totalDistanceMeters : target.originalDistanceMeters,
    acceptedDistanceMeters: nextAccepted,
    sections: nextSections,
  });

  clearOfflineWaypointsForAssessment(
    assessmentId,
    queued.map((q) => q.point.clientPointId),
  );

  return { assessment: saved, syncedCount: newCount };
}

export async function returnAssessment(
  session: AuthSession,
  assessmentId: string,
  comment: string,
): Promise<SiteAssessment> {
  if (!can(session.role, "assessments.review")) {
    throw new Error("Access denied: only Management / Admin can return assessments.");
  }
  if (!comment.trim()) throw new Error("Provide a clear reason when returning an assessment.");
  const { assessments } = await listAssessmentsAndBenchmarks(session);
  const target = assessments.find((a) => a.id === assessmentId);
  if (!target) throw new Error("Assessment not found.");
  assertBusinessBoundary(session, target.businessId, "assessment");
  return saveAssessmentDraft(session, {
    ...target,
    status: "returned",
    reviewComment: comment.trim(),
  });
}

/**
 * Approve an assessment (or approve a scope amendment on an already-approved assessment).
 * Creates an immutable revision snapshot (baseline Rev 1 or amendment Rev N+1) and
 * creates/updates the linked Planned Job (T24).
 */
export async function approveAssessmentScope(
  session: AuthSession,
  assessment: SiteAssessment,
  approvalReason: string,
): Promise<SiteAssessment> {
  if (!can(session.role, "scope.approve")) {
    throw new Error("Access denied: only Management / Admin can approve scope and budget.");
  }
  assertBusinessBoundary(session, assessment.businessId, "assessment");
  const sectionErrors = validateAssessmentSections(assessment.sections);
  if (sectionErrors.length > 0) throw new Error(sectionErrors[0]!);

  if (assessment.benchmarkProductivitySqm<=0 || assessment.productiveCrewSize<=0 || assessment.roadWorkerDailyRateCents<=0 || assessment.workdaysPerWeek<=0 || (assessment.includeCook && assessment.cookWeeklyRateCents<=0)) throw new Error('Enter confirmed planning productivity, crew, wage rates and working calendar before approval.');
  const sizing = calculateAssessmentSizing({
    sections: assessment.sections,
    benchmarkProductivitySqm: assessment.benchmarkProductivitySqm,
    productiveCrewSize: assessment.productiveCrewSize,
    roadWorkerDailyRateCents: assessment.roadWorkerDailyRateCents,
    cookWeeklyRateCents: assessment.cookWeeklyRateCents,
    includeCook: assessment.includeCook,
    workdaysPerWeek: assessment.workdaysPerWeek,
    contractValueCents: assessment.contractValueCents,
    budgetLines: assessment.budgetLines,
  });

  if (sizing.unknownWidthCount > 0) {
    throw new Error("Resolve all unknown strip widths before approving scope.");
  }

  const isAmendment = assessment.revisions.length > 0;
  if (isAmendment && !approvalReason.trim()) {
    throw new Error("A documented reason is required for a scope amendment after baseline approval.");
  }

  const nextRevision = assessment.revisions.length + 1;
  const normalizedPoints = assessment.routePoints?.length
    ? resequenceRoutePoints(assessment.routePoints)
    : hydrateRoutePoints(undefined, assessment.startGps, assessment.endGps, assessment.createdByEmail);
  const routeMetrics = calculateRouteMetrics(normalizedPoints);

  const snapshot: AssessmentRevisionSnapshot = {
    revision: nextRevision,
    approvedAt: new Date().toISOString(),
    approvedByEmail: session.email,
    reason: approvalReason.trim() || "Initial baseline scope approval",
    acceptedDistanceMeters: assessment.acceptedDistanceMeters,
    waypointMeasuredDistanceMeters:
      normalizedPoints.length >= 2
        ? routeMetrics.totalDistanceMeters
        : (assessment.waypointMeasuredDistanceMeters ?? null),
    roadNetworkDistanceMeters: assessment.roadNetworkDistanceMeters ?? null,
    routePoints: JSON.parse(JSON.stringify(normalizedPoints)),
    roadLengthMeters: sizing.roadLengthMeters,
    vergeLengthMeters: sizing.vergeLengthMeters,
    physicalAreaSqm: sizing.physicalAreaSqm,
    effortUnitsSqm: sizing.effortUnitsSqm,
    requiredWorkerDays: sizing.requiredWorkerDays,
    plannedCrewDays: sizing.plannedCrewDays,
    estimatedLabourCents: sizing.estimatedLabourCents,
    estimatedOperatingCents: sizing.estimatedTotalOperatingCents,
    estimatedCapitalCents: sizing.estimatedCapitalCents,
    contractValueCents: assessment.contractValueCents,
    sections: JSON.parse(JSON.stringify(assessment.sections)),
  };

  // Create or update linked Planned Job on baseline approval
  let linkedJobId = assessment.jobId;
  if (!linkedJobId) {
    const createdJob = await saveJob(session, {
      name: assessment.name,
      customerName: assessment.customerName || "Pending customer confirmation",
      contractReference: `ASMT-REV-${nextRevision}`,
      contractValueCents: assessment.contractValueCents,
      vatBasis: "not_registered",
      roadOrArea: assessment.roadOrArea,
      status: "planned",
      plannedStartDate: null,
      plannedEndDate: null,
      openingCashAllocationCents: 0,
      workRequirements: `Approved baseline Rev ${nextRevision}: ${(sizing.roadLengthMeters / 1000).toFixed(2)} km road, ${(sizing.vergeLengthMeters / 1000).toFixed(2)} km verge, ${sizing.physicalAreaSqm.toLocaleString()} m².`,
    });
    linkedJobId = createdJob.id;
  }

  return saveAssessmentDraft(session, {
    ...assessment,
    jobId: linkedJobId,
    status: "approved",
    revision: nextRevision,
    reviewComment: null,
    revisions: [...assessment.revisions, snapshot],
  });
}