import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { SYNTHETIC_BIZ_A } from "@/lib/data/synthetic-fixtures";
import { saveJob } from "@/lib/data/repository";
import { calculateAssessmentSizing, validateAssessmentSections } from "@/lib/domain/assessment-calc";
import type {
  AssessmentRevisionSnapshot,
  BenchmarkProfile,
  SiteAssessment,
} from "@/lib/domain/assessment-types";
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
    return JSON.parse(raw) as SyntheticAssessmentStore;
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
  },
): Promise<SiteAssessment> {
  if (!can(session.role, "assessments.create")) {
    throw new Error("Access denied: you cannot create or edit site assessments.");
  }
  if (!input.name.trim()) throw new Error("Job or road name is required.");
  if (!input.roadOrArea.trim()) throw new Error("Road or area is required.");
  if (input.acceptedDistanceMeters <= 0) {
    throw new Error("Road distance must be greater than 0 metres.");
  }
  const sectionErrors = validateAssessmentSections(input.sections);
  if (sectionErrors.length > 0) {
    throw new Error(sectionErrors[0]!);
  }

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
      start_gps: input.startGps,
      end_gps: input.endGps,
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
    const query = input.id
      ? supabase
          .from("assessments")
          .update(payload)
          .eq("id", input.id)
          .eq("business_id", session.businessId)
          .select("*")
          .single()
      : supabase
          .from("assessments")
          .insert({ ...payload, created_by: session.userId, created_by_email: session.email })
          .select("*")
          .single();
    const { data, error } = await query;
    if (error || !data) throw new Error(error?.message ?? "Failed to save assessment.");
    return {
      ...input,
      id: data.id,
      businessId: data.business_id,
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
    createdByEmail: session.email,
    createdAt: now,
    updatedAt: now,
  };
  store.assessments.unshift(created);
  saveStore(store);
  return created;
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
  const snapshot: AssessmentRevisionSnapshot = {
    revision: nextRevision,
    approvedAt: new Date().toISOString(),
    approvedByEmail: session.email,
    reason: approvalReason.trim() || "Initial baseline scope approval",
    acceptedDistanceMeters: assessment.acceptedDistanceMeters,
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