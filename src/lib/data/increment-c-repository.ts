import {encodeRow} from "@/lib/data/database-store";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { SYNTHETIC_BIZ_A, SYNTHETIC_JOB_1 } from "@/lib/data/synthetic-fixtures";
import type { AuthSession } from "@/lib/domain/types";
import type {
  AttendanceEntry,
  DayWorkStatus,
  InterruptionEntry,
  InterruptionReason,
  PayrollAdjustment,
  PayrollRun,
  ProgressEntry,
  ProgressSource,
  ProgressStageStatus,
  TeamDay,
} from "@/lib/domain/increment-c-types";
import type { RoadSectionInput, ScopeActivity, VergeSide } from "@/lib/domain/assessment-types";
import { detectProgressScopeConflict } from "@/lib/domain/progress-calc";
import {
  calculatePayrollWeek,
  getWeekDates,
  validateAttendanceEntryHours,
} from "@/lib/domain/payroll-calc";
import { listWorkforceBundle, listJobs } from "@/lib/data/repository";
import { assertBusinessBoundary, can, canAccessJob } from "@/lib/permissions";

const STORAGE_KEY = "worktrack_synthetic_increment_c_v1";

interface SyntheticIncrementCStore {
  progressEntries: ProgressEntry[];
  interruptions: InterruptionEntry[];
  teamDays: TeamDay[];
  attendanceEntries: AttendanceEntry[];
  payrollRuns: PayrollRun[];
}

function newId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Default approved scope fallback for Synthetic Job 1 when no linked approved assessment exists yet.
 */
export function getDefaultScopeForJob(jobId: string): RoadSectionInput[] {
  if (jobId === SYNTHETIC_JOB_1) {
    return [
      {
        id: "syn-job1-sec-1",
        label: "R63 Section North (0m – 10 000m)",
        startChainageMeters: 0,
        endChainageMeters: 10000,
        carriageway: "single",
        strips: [
          { id: "syn-st-l", side: "left", widthMeters: 5, lengthOverrideMeters: null },
          { id: "syn-st-r", side: "right", widthMeters: 5, lengthOverrideMeters: null },
        ],
        difficulty: "similar",
        difficultyReasons: ["thick_grass"],
        activities: ["cutting", "waste_collection"],
        notes: "Synthetic baseline scope for R63 Section North.",
      },
    ];
  }
  return [];
}

function createInitialIncrementCStore(): SyntheticIncrementCStore {
  const now = "2026-11-27T09:00:00.000Z";
  return {
    progressEntries: [
      {
        id: "prog-syn-1",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        sectionId: "syn-job1-sec-1",
        vergeSide: "left",
        activity: "cutting",
        reportedDate: "2026-11-23",
        startChainageMeters: 0,
        endChainageMeters: 500,
        stageStatus: "complete",
        isRework: false,
        source: "manual",
        gpsAccuracyMeters: null,
        photoDate: "2026-11-23",
        evidenceNote: "Synthetic sample cutting entry (0m–500m left verge).",
        verificationState: "reported",
        conflictReason: null,
        submittedByEmail: "owner@synthetic.worktrack.local",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "prog-syn-2",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        sectionId: "syn-job1-sec-1",
        vergeSide: "left",
        activity: "waste_collection",
        reportedDate: "2026-11-24",
        startChainageMeters: 0,
        endChainageMeters: 400,
        stageStatus: "complete",
        isRework: false,
        source: "manual",
        gpsAccuracyMeters: null,
        photoDate: "2026-11-24",
        evidenceNote: "Synthetic sample waste removal (0m–400m left verge).",
        verificationState: "reported",
        conflictReason: null,
        submittedByEmail: "owner@synthetic.worktrack.local",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    interruptions: [
      {
        id: "int-syn-1",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        interruptionDate: "2026-11-25",
        durationHours: 3,
        fullDay: false,
        affectedCrewOrSection: "Full clearing crew — R63 km 12–13",
        reason: "rain",
        comment: "Heavy afternoon thunderstorm halted brush-cutters (synthetic).",
        submittedByEmail: "supervisor@synthetic.worktrack.local",
        createdAt: now,
      },
    ],
    teamDays: [
      {
        id: "td-syn-1",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workDate: "2026-11-23",
        dayStatus: "worked",
        normalHours: 9,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        interruptionReason: null,
        notes: "Full crew worked",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: now,
      },
      {
        id: "td-syn-2",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workDate: "2026-11-24",
        dayStatus: "worked",
        normalHours: 9,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        interruptionReason: null,
        notes: "Full crew worked",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: now,
      },
      {
        id: "td-syn-3",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workDate: "2026-11-25",
        dayStatus: "partial",
        normalHours: 6,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        interruptionReason: "rain",
        notes: "Stopped early due to thunderstorm",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: now,
      },
      {
        id: "td-syn-4",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workDate: "2026-11-26",
        dayStatus: "worked",
        normalHours: 9,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        interruptionReason: null,
        notes: "",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: now,
      },
      {
        id: "td-syn-5",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workDate: "2026-11-27",
        dayStatus: "unknown",
        normalHours: 0,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        interruptionReason: null,
        notes: "Pending Friday confirmation",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: now,
      },
      {
        id: "td-syn-6",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workDate: "2026-11-28",
        dayStatus: "no_work",
        normalHours: 0,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        interruptionReason: null,
        notes: "Saturday — rest day",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: now,
      },
      {
        id: "td-syn-7",
        businessId: SYNTHETIC_BIZ_A,
        jobId: SYNTHETIC_JOB_1,
        workDate: "2026-11-29",
        dayStatus: "no_work",
        normalHours: 0,
        weekdayOtHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        publicHolidayHours: 0,
        interruptionReason: null,
        notes: "Sunday — rest day",
        updatedByEmail: "owner@synthetic.worktrack.local",
        updatedAt: now,
      },
    ],
    attendanceEntries: [],
    payrollRuns: [],
  };
}

let memStore: SyntheticIncrementCStore | null = null;

function loadStore(): SyntheticIncrementCStore {
  if (typeof window === "undefined") {
    if (!memStore) memStore = createInitialIncrementCStore();
    return memStore;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SyntheticIncrementCStore;
  } catch {
    // ignore storage parse error
  }
  const initial = createInitialIncrementCStore();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  return initial;
}

function saveStore(store: SyntheticIncrementCStore): void {
  if (typeof window === "undefined") {
    memStore = store;
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function resetSyntheticIncrementCStore(): void {
  const initial = createInitialIncrementCStore();
  saveStore(initial);
}

async function assertJobReadable(session: AuthSession, jobId: string): Promise<void> {
  const jobs = await listJobs(session);
  const job = jobs.find((j) => j.id === jobId);
  if (!job || !canAccessJob(session, job.id, job.businessId)) {
    throw new Error("Access denied: you do not have access to this job.");
  }
}

// ============================================================================
// Progress & Interruptions
// ============================================================================
export async function listJobProgressBundle(
  session: AuthSession,
  jobId: string,
): Promise<{ entries: ProgressEntry[]; interruptions: InterruptionEntry[] }> {
  await assertJobReadable(session, jobId);

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const [pRes, iRes] = await Promise.all([
      supabase
        .from("progress_entries")
        .select("*")
        .eq("business_id", session.businessId)
        .eq("job_id", jobId)
        .order("reported_date", { ascending: false }),
      supabase
        .from("interruptions")
        .select("*")
        .eq("business_id", session.businessId)
        .eq("job_id", jobId)
        .order("interruption_date", { ascending: false }),
    ]);
    if (pRes.error) throw new Error(pRes.error.message);
    if (iRes.error) throw new Error(iRes.error.message);

    return {
      entries: (pRes.data ?? []).map((r) => ({
        id: r.id,
        businessId: r.business_id,
        jobId: r.job_id,
        sectionId: r.section_id,
        vergeSide: r.verge_side as VergeSide,
        activity: r.activity as ScopeActivity,
        reportedDate: r.reported_date,
        startChainageMeters: Number(r.start_chainage_meters),
        endChainageMeters: Number(r.end_chainage_meters),
        stageStatus: r.stage_status as ProgressStageStatus,
        isRework: Boolean(r.is_rework),
        source: r.source as ProgressSource,
        gpsAccuracyMeters: r.gps_accuracy_meters == null ? null : Number(r.gps_accuracy_meters),
        photoDate: r.photo_date,
        evidenceNote: r.evidence_note ?? "",
        verificationState: r.verification_state,
        conflictReason: r.conflict_reason,
        submittedByEmail: r.submitted_by_email,
        revision: Number(r.revision),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      interruptions: (iRes.data ?? []).map((r) => ({
        id: r.id,
        businessId: r.business_id,
        jobId: r.job_id,
        interruptionDate: r.interruption_date,
        durationHours: Number(r.duration_hours),
        fullDay: Boolean(r.full_day),
        affectedCrewOrSection: r.affected_crew_or_section ?? "",
        reason: r.reason as InterruptionReason,
        comment: r.comment ?? "",
        submittedByEmail: r.submitted_by_email,
        createdAt: r.created_at,
      })),
    };
  }

  const store = loadStore();
  return {
    entries: store.progressEntries
      .filter((e) => e.businessId === session.businessId && e.jobId === jobId)
      .sort((a, b) => b.reportedDate.localeCompare(a.reportedDate)),
    interruptions: store.interruptions
      .filter((i) => i.businessId === session.businessId && i.jobId === jobId)
      .sort((a, b) => b.interruptionDate.localeCompare(a.interruptionDate)),
  };
}

export async function createProgressEntries(
  session: AuthSession,
  input: {
    jobId: string;
    section: RoadSectionInput;
    vergeSides: VergeSide[];
    activity: ScopeActivity;
    reportedDate: string;
    startChainageMeters: number;
    endChainageMeters: number;
    stageStatus: ProgressStageStatus;
    isRework: boolean;
    source: ProgressSource;
    gpsAccuracyMeters: number | null;
    photoDate: string | null;
    evidenceNote: string;
  },
): Promise<ProgressEntry[]> {
  await assertJobReadable(session, input.jobId);
  if (input.vergeSides.length === 0) {
    throw new Error("Select at least one verge strip.");
  }
  if (
    !Number.isFinite(input.startChainageMeters) ||
    !Number.isFinite(input.endChainageMeters) ||
    input.startChainageMeters < 0 ||
    input.endChainageMeters <= input.startChainageMeters
  ) {
    throw new Error("End chainage must be greater than start chainage (both non-negative).");
  }

  const conflict = detectProgressScopeConflict(
    input.section,
    input.startChainageMeters,
    input.endChainageMeters,
    input.activity,
  );
  const now = new Date().toISOString();

  // Expand multi-verge selection into distinct per-strip records (Spec Section 7)
  const created: ProgressEntry[] = input.vergeSides.map((side) => ({
    id: newId("prog"),
    businessId: session.businessId,
    jobId: input.jobId,
    sectionId: input.section.id,
    vergeSide: side,
    activity: input.activity,
    reportedDate: input.reportedDate,
    startChainageMeters: input.startChainageMeters,
    endChainageMeters: input.endChainageMeters,
    stageStatus: input.stageStatus,
    isRework: input.isRework,
    source: input.source,
    gpsAccuracyMeters: input.gpsAccuracyMeters,
    photoDate: input.photoDate,
    evidenceNote: input.evidenceNote.trim(),
    verificationState: conflict ? "flagged_conflict" : "reported",
    conflictReason: conflict,
    submittedByEmail: session.email,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }));

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const { error } = await supabase.from("progress_entries").insert(
      created.map((c) => ({
        id: c.id,
        business_id: c.businessId,
        job_id: c.jobId,
        section_id: c.sectionId,
        verge_side: c.vergeSide,
        activity: c.activity,
        reported_date: c.reportedDate,
        start_chainage_meters: c.startChainageMeters,
        end_chainage_meters: c.endChainageMeters,
        stage_status: c.stageStatus,
        is_rework: c.isRework,
        source: c.source,
        gps_accuracy_meters: c.gpsAccuracyMeters,
        photo_date: c.photoDate,
        evidence_note: c.evidenceNote,
        verification_state: c.verificationState,
        conflict_reason: c.conflictReason,
        submitted_by_email: c.submittedByEmail,
        revision: c.revision,
      })),
    );
    if (error) throw new Error(error.message);
    return created;
  }

  const store = loadStore();
  store.progressEntries.unshift(...created);
  saveStore(store);
  return created;
}

export async function verifyProgressEntry(
  session: AuthSession,
  entryId: string,
  verificationState: "verified" | "flagged_conflict",
): Promise<void> {
  if (!can(session.role, "jobs.manage") && session.role !== "owner") {
    throw new Error("Only Admin or Owner can verify progress entries.");
  }
  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const { error } = await supabase
      .from("progress_entries")
      .update({
        verification_state: verificationState,
        conflict_reason: verificationState === "verified" ? null : "Flagged during review",
        updated_at: new Date().toISOString(),
      })
      .eq("id", entryId)
      .eq("business_id", session.businessId);
    if (error) throw new Error(error.message);
    return;
  }
  const store = loadStore();
  const entry = store.progressEntries.find((e) => e.id === entryId);
  if (!entry) throw new Error("Progress entry not found.");
  assertBusinessBoundary(session, entry.businessId, "progress entry");
  entry.verificationState = verificationState;
  if (verificationState === "verified") entry.conflictReason = null;
  entry.updatedAt = new Date().toISOString();
  saveStore(store);
}

export async function createInterruption(
  session: AuthSession,
  input: {
    jobId: string;
    interruptionDate: string;
    durationHours: number;
    fullDay: boolean;
    affectedCrewOrSection: string;
    reason: InterruptionReason;
    comment: string;
  },
): Promise<InterruptionEntry> {
  await assertJobReadable(session, input.jobId);
  if (!Number.isFinite(input.durationHours) || input.durationHours < 0 || input.durationHours > 24) {
    throw new Error("Duration hours must be between 0 and 24.");
  }
  const entry: InterruptionEntry = {
    id: newId("int"),
    businessId: session.businessId,
    jobId: input.jobId,
    interruptionDate: input.interruptionDate,
    durationHours: input.fullDay ? 9 : input.durationHours,
    fullDay: input.fullDay,
    affectedCrewOrSection: input.affectedCrewOrSection.trim(),
    reason: input.reason,
    comment: input.comment.trim(),
    submittedByEmail: session.email,
    createdAt: new Date().toISOString(),
  };

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const { error } = await supabase.from("interruptions").insert({
      id: entry.id,
      business_id: entry.businessId,
      job_id: entry.jobId,
      interruption_date: entry.interruptionDate,
      duration_hours: entry.durationHours,
      full_day: entry.fullDay,
      affected_crew_or_section: entry.affectedCrewOrSection,
      reason: entry.reason,
      comment: entry.comment,
      submitted_by_email: entry.submittedByEmail,
    });
    if (error) throw new Error(error.message);
    return entry;
  }

  const store = loadStore();
  store.interruptions.unshift(entry);
  saveStore(store);
  return entry;
}

// ============================================================================
// Weekly Attendance (Team Days + Worker Exceptions)
// ============================================================================
export async function listAttendanceForWeek(
  session: AuthSession,
  jobId: string,
  weekStartDate: string,
): Promise<{
  teamDays: TeamDay[];
  attendanceEntries: AttendanceEntry[];
  otherJobAttendance: AttendanceEntry[];
}> {
  if (!can(session.role, "attendance.capture")) {
    throw new Error("You do not have permission to view attendance.");
  }
  await assertJobReadable(session, jobId);
  const dates = getWeekDates(weekStartDate);
  const weekEndDate = dates[6]!;

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const [tRes, aRes, otherRes] = await Promise.all([
      supabase
        .from("team_days")
        .select("*")
        .eq("business_id", session.businessId)
        .eq("job_id", jobId)
        .gte("work_date", weekStartDate)
        .lte("work_date", weekEndDate),
      supabase
        .from("attendance_entries")
        .select("*")
        .eq("business_id", session.businessId)
        .eq("job_id", jobId)
        .gte("work_date", weekStartDate)
        .lte("work_date", weekEndDate),
      supabase
        .from("attendance_entries")
        .select("*")
        .eq("business_id", session.businessId)
        .neq("job_id", jobId)
        .gte("work_date", weekStartDate)
        .lte("work_date", weekEndDate),
    ]);
    if (tRes.error) throw new Error(tRes.error.message);
    if (aRes.error) throw new Error(aRes.error.message);
    if (otherRes.error) throw new Error(otherRes.error.message);

    const mapAtt = (r: Record<string, unknown>): AttendanceEntry => ({
      id: String(r["id"]),
      revision:Number(r["revision"]??1),
      businessId: String(r["business_id"]),
      jobId: String(r["job_id"]),
      workerId: String(r["worker_id"]),
      workDate: String(r["work_date"]),
      dayStatus: r["day_status"] as DayWorkStatus,
      normalHours: Number(r["normal_hours"]),
      weekdayOtHours: Number(r["weekday_ot_hours"]),
      saturdayHours: Number(r["saturday_hours"]),
      sundayHours: Number(r["sunday_hours"]),
      publicHolidayHours: Number(r["public_holiday_hours"]),
      isOverride: Boolean(r["is_override"]),
      overrideReason: (r["override_reason"] as string | null) ?? null,
      updatedByEmail: String(r["updated_by_email"]),
      updatedAt: String(r["updated_at"]),
    });

    return {
      teamDays: (tRes.data ?? []).map((r) => ({
        id: r.id,
        revision:Number(r.revision??1),
        businessId: r.business_id,
        jobId: r.job_id,
        workDate: r.work_date,
        dayStatus: r.day_status as DayWorkStatus,
        normalHours: Number(r.normal_hours),
        weekdayOtHours: Number(r.weekday_ot_hours),
        saturdayHours: Number(r.saturday_hours),
        sundayHours: Number(r.sunday_hours),
        publicHolidayHours: Number(r.public_holiday_hours),
        interruptionReason: (r.interruption_reason as InterruptionReason | null) ?? null,
        notes: r.notes ?? "",
        updatedByEmail: r.updated_by_email,
        updatedAt: r.updated_at,
      })),
      attendanceEntries: (aRes.data ?? []).map(mapAtt),
      otherJobAttendance: (otherRes.data ?? []).map(mapAtt),
    };
  }

  const store = loadStore();
  return {
    teamDays: store.teamDays.filter(
      (t) =>
        t.businessId === session.businessId &&
        t.jobId === jobId &&
        t.workDate >= weekStartDate &&
        t.workDate <= weekEndDate,
    ),
    attendanceEntries: store.attendanceEntries.filter(
      (a) =>
        a.businessId === session.businessId &&
        a.jobId === jobId &&
        a.workDate >= weekStartDate &&
        a.workDate <= weekEndDate,
    ),
    otherJobAttendance: store.attendanceEntries.filter(
      (a) =>
        a.businessId === session.businessId &&
        a.jobId !== jobId &&
        a.workDate >= weekStartDate &&
        a.workDate <= weekEndDate,
    ),
  };
}

export async function upsertTeamDay(
  session: AuthSession,
  input: {
    jobId: string;
    workDate: string;
    dayStatus: DayWorkStatus;
    normalHours: number;
    weekdayOtHours: number;
    saturdayHours: number;
    sundayHours: number;
    publicHolidayHours: number;
    interruptionReason: InterruptionReason | null;
    notes: string;
  },
): Promise<TeamDay> {
  if (!can(session.role, "attendance.capture")) {
    throw new Error("You do not have permission to update team attendance.");
  }
  await assertJobReadable(session, input.jobId);
  const hrsErr = validateAttendanceEntryHours(input);
  if (hrsErr) throw new Error(hrsErr);

  const now = new Date().toISOString();

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const { data, error } = await supabase
      .from("team_days")
      .upsert(
        {
          business_id: session.businessId,
          job_id: input.jobId,
          work_date: input.workDate,
          day_status: input.dayStatus,
          normal_hours: input.normalHours,
          weekday_ot_hours: input.weekdayOtHours,
          saturday_hours: input.saturdayHours,
          sunday_hours: input.sundayHours,
          public_holiday_hours: input.publicHolidayHours,
          interruption_reason: input.interruptionReason,
          notes: input.notes.trim(),
          updated_by_email: session.email,
          updated_at: now,
        },
        { onConflict: "business_id,job_id,work_date" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return {
      id: data.id,
      businessId: data.business_id,
      jobId: data.job_id,
      workDate: data.work_date,
      dayStatus: data.day_status as DayWorkStatus,
      normalHours: Number(data.normal_hours),
      weekdayOtHours: Number(data.weekday_ot_hours),
      saturdayHours: Number(data.saturday_hours),
      sundayHours: Number(data.sunday_hours),
      publicHolidayHours: Number(data.public_holiday_hours),
      interruptionReason: (data.interruption_reason as InterruptionReason | null) ?? null,
      notes: data.notes ?? "",
      updatedByEmail: data.updated_by_email,
      updatedAt: data.updated_at,
    };
  }

  const store = loadStore();
  const existing = store.teamDays.find(
    (t) =>
      t.businessId === session.businessId &&
      t.jobId === input.jobId &&
      t.workDate === input.workDate,
  );
  if (existing) {
    Object.assign(existing, {
      dayStatus: input.dayStatus,
      normalHours: input.normalHours,
      weekdayOtHours: input.weekdayOtHours,
      saturdayHours: input.saturdayHours,
      sundayHours: input.sundayHours,
      publicHolidayHours: input.publicHolidayHours,
      interruptionReason: input.interruptionReason,
      notes: input.notes.trim(),
      updatedByEmail: session.email,
      updatedAt: now,
    });
    saveStore(store);
    return existing;
  }
  const created: TeamDay = {
    id: newId("td"),
    businessId: session.businessId,
    jobId: input.jobId,
    workDate: input.workDate,
    dayStatus: input.dayStatus,
    normalHours: input.normalHours,
    weekdayOtHours: input.weekdayOtHours,
    saturdayHours: input.saturdayHours,
    sundayHours: input.sundayHours,
    publicHolidayHours: input.publicHolidayHours,
    interruptionReason: input.interruptionReason,
    notes: input.notes.trim(),
    updatedByEmail: session.email,
    updatedAt: now,
  };
  store.teamDays.push(created);
  saveStore(store);
  return created;
}

export async function upsertWorkerAttendanceOverride(
  session: AuthSession,
  input: {
    jobId: string;
    workerId: string;
    workDate: string;
    dayStatus: DayWorkStatus;
    normalHours: number;
    weekdayOtHours: number;
    saturdayHours: number;
    sundayHours: number;
    publicHolidayHours: number;
    overrideReason: string;
  },
): Promise<AttendanceEntry> {
  if (!can(session.role, "attendance.capture")) {
    throw new Error("You do not have permission to update worker attendance.");
  }
  await assertJobReadable(session, input.jobId);
  const hrsErr = validateAttendanceEntryHours(input);
  if (hrsErr) throw new Error(hrsErr);

  const now = new Date().toISOString();

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const { data, error } = await supabase
      .from("attendance_entries")
      .upsert(
        {
          business_id: session.businessId,
          job_id: input.jobId,
          worker_id: input.workerId,
          work_date: input.workDate,
          day_status: input.dayStatus,
          normal_hours: input.normalHours,
          weekday_ot_hours: input.weekdayOtHours,
          saturday_hours: input.saturdayHours,
          sunday_hours: input.sundayHours,
          public_holiday_hours: input.publicHolidayHours,
          is_override: true,
          override_reason: input.overrideReason.trim() || null,
          updated_by_email: session.email,
          updated_at: now,
        },
        { onConflict: "business_id,worker_id,job_id,work_date" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return {
      id: data.id,
      businessId: data.business_id,
      jobId: data.job_id,
      workerId: data.worker_id,
      workDate: data.work_date,
      dayStatus: data.day_status as DayWorkStatus,
      normalHours: Number(data.normal_hours),
      weekdayOtHours: Number(data.weekday_ot_hours),
      saturdayHours: Number(data.saturday_hours),
      sundayHours: Number(data.sunday_hours),
      publicHolidayHours: Number(data.public_holiday_hours),
      isOverride: Boolean(data.is_override),
      overrideReason: data.override_reason,
      updatedByEmail: data.updated_by_email,
      updatedAt: data.updated_at,
    };
  }

  const store = loadStore();
  const existing = store.attendanceEntries.find(
    (a) =>
      a.businessId === session.businessId &&
      a.jobId === input.jobId &&
      a.workerId === input.workerId &&
      a.workDate === input.workDate,
  );
  if (existing) {
    Object.assign(existing, {
      dayStatus: input.dayStatus,
      normalHours: input.normalHours,
      weekdayOtHours: input.weekdayOtHours,
      saturdayHours: input.saturdayHours,
      sundayHours: input.sundayHours,
      publicHolidayHours: input.publicHolidayHours,
      isOverride: true,
      overrideReason: input.overrideReason.trim() || null,
      updatedByEmail: session.email,
      updatedAt: now,
    });
    saveStore(store);
    return existing;
  }
  const created: AttendanceEntry = {
    id: newId("att"),
    businessId: session.businessId,
    jobId: input.jobId,
    workerId: input.workerId,
    workDate: input.workDate,
    dayStatus: input.dayStatus,
    normalHours: input.normalHours,
    weekdayOtHours: input.weekdayOtHours,
    saturdayHours: input.saturdayHours,
    sundayHours: input.sundayHours,
    publicHolidayHours: input.publicHolidayHours,
    isOverride: true,
    overrideReason: input.overrideReason.trim() || null,
    updatedByEmail: session.email,
    updatedAt: now,
  };
  store.attendanceEntries.push(created);
  saveStore(store);
  return created;
}

export async function resetWorkerDayToTeam(
  session: AuthSession,
  jobId: string,
  workerId: string,
  workDate: string,
): Promise<void> {
  if (!can(session.role, "attendance.capture")) {
    throw new Error("You do not have permission to reset attendance.");
  }
  await assertJobReadable(session, jobId);

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const { error } = await supabase
      .from("attendance_entries")
      .delete()
      .eq("business_id", session.businessId)
      .eq("job_id", jobId)
      .eq("worker_id", workerId)
      .eq("work_date", workDate);
    if (error) throw new Error(error.message);
    return;
  }

  const store = loadStore();
  store.attendanceEntries = store.attendanceEntries.filter(
    (a) =>
      !(
        a.businessId === session.businessId &&
        a.jobId === jobId &&
        a.workerId === workerId &&
        a.workDate === workDate
      ),
  );
  saveStore(store);
}

export async function copyPriorWeekAsDraft(
  session: AuthSession,
  jobId: string,
  targetWeekStartDate: string,
): Promise<number> {
  if (!can(session.role, "attendance.capture")) {
    throw new Error("You do not have permission to copy attendance.");
  }
  await assertJobReadable(session, jobId);
  const targetDates = getWeekDates(targetWeekStartDate);
  const priorStart = new Date(`${targetWeekStartDate}T00:00:00Z`);
  priorStart.setUTCDate(priorStart.getUTCDate() - 7);
  const priorWeekStartDate = priorStart.toISOString().slice(0, 10);
  const priorDates = getWeekDates(priorWeekStartDate);

  const prior = await listAttendanceForWeek(session, jobId, priorWeekStartDate);
  let copiedCount = 0;
  for (let i = 0; i < 7; i++) {
    const prevDay = prior.teamDays.find((t) => t.workDate === priorDates[i]);
    if (!prevDay) continue;
    await upsertTeamDay(session, {
      jobId,
      workDate: targetDates[i]!,
      dayStatus: prevDay.dayStatus,
      normalHours: prevDay.normalHours,
      weekdayOtHours: prevDay.weekdayOtHours,
      saturdayHours: prevDay.saturdayHours,
      sundayHours: prevDay.sundayHours,
      publicHolidayHours: prevDay.publicHolidayHours,
      interruptionReason: prevDay.interruptionReason,
      notes: prevDay.notes ? `${prevDay.notes} (copied draft)` : "Copied from prior week (draft)",
    });
    copiedCount++;
  }
  return copiedCount;
}

// ============================================================================
// Payroll Runs (STRICTLY DENIED FOR SUPERVISORS — T21)
// ============================================================================
export async function listPayrollRuns(
  session: AuthSession,
  jobId?: string,
): Promise<PayrollRun[]> {
  if (!can(session.role, "payroll.view")) {
    throw new Error("Access denied: Supervisors cannot view payroll data or worker statements.");
  }

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    let q = supabase
      .from("payroll_runs")
      .select("*, payroll_earnings(*), payroll_adjustments(*)")
      .eq("business_id", session.businessId)
      .order("week_start_date", { ascending: false })
      .order("revision", { ascending: false });
    if (jobId) q = q.eq("job_id", jobId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const bundle = await listWorkforceBundle(session);
    const workerMap = new Map(bundle.workers.map((w) => [w.id, w]));
    const roleMap = new Map(bundle.roles.map((r) => [r.id, r]));

    return (data ?? []).map((r) => ({
      id: r.id,
      businessId: r.business_id,
      jobId: r.job_id,
      weekStartDate: r.week_start_date,
      weekEndDate: r.week_end_date,
      revision: Number(r.revision),
      status: r.status,
      grossTotalCents: Number(r.gross_total_cents),
      adjustmentsTotalCents: Number(r.adjustments_total_cents),
      deductionsTotalCents: Number(r.deductions_total_cents),
      netTotalCents: Number(r.net_total_cents),
      approvedByEmail: r.approved_by_email,
      approvedAt: r.approved_at,
      correctionReason: r.correction_reason,
      supersedesRunId: r.supersedes_run_id,
      createdByEmail: r.created_by_email,
      createdAt: r.created_at,
      earnings: ((r.payroll_earnings as Array<Record<string, unknown>>) ?? []).map((e) => {
        const w = workerMap.get(String(e["worker_id"]));
        const role = w ? roleMap.get(w.workerRoleId) : undefined;
        return {
          id: String(e["id"]),
          workerId: String(e["worker_id"]),
          workerName: w?.fullName ?? "Worker",
          roleName: role?.name ?? "Role",
          roleType: role?.roleType ?? "other",
          daysWorked: Number(e["days_worked"]),
          normalHours: Number(e["normal_hours"]),
          weekdayOtHours: Number(e["weekday_ot_hours"]),
          saturdayHours: Number(e["saturday_hours"]),
          sundayHours: Number(e["sunday_hours"]),
          publicHolidayHours: Number(e["public_holiday_hours"]),
          normalPayCents: Number(e["normal_pay_cents"]),
          weekdayOtPayCents: Number(e["weekday_ot_pay_cents"]),
          saturdayPayCents: Number(e["saturday_pay_cents"]),
          sundayPayCents: Number(e["sunday_pay_cents"]),
          publicHolidayPayCents: Number(e["public_holiday_pay_cents"]),
          grossPayCents: Number(e["gross_pay_cents"]),
          adjustmentsCents: Number(e["adjustments_cents"]),
          deductionsCents: Number(e["deductions_cents"]),
          netPayCents: Number(e["net_pay_cents"]),
          hasUnknownAttendance: false,
          hasUnconfirmedRate: false,
          missingRateReasons: [],
          ruleSnapshots: (e["rule_snapshots"] as PayrollRun["earnings"][number]["ruleSnapshots"]) ?? [],
        };
      }),
      adjustments: ((r.payroll_adjustments as Array<Record<string, unknown>>) ?? []).map((a) => ({
        id: String(a["id"]),
        businessId: String(a["business_id"]),
        payrollRunId: String(a["payroll_run_id"]),
        workerId: String(a["worker_id"]),
        kind: a["kind"] as PayrollAdjustment["kind"],
        description: String(a["description"]),
        amountCents: Number(a["amount_cents"]),
        approvedByEmail: String(a["approved_by_email"]),
        createdAt: String(a["created_at"]),
      })),
    }));
  }

  const store = loadStore();
  return store.payrollRuns
    .filter((r) => r.businessId === session.businessId && (!jobId || r.jobId === jobId))
    .sort(
      (a, b) =>
        b.weekStartDate.localeCompare(a.weekStartDate) || b.revision - a.revision,
    );
}

export async function savePayrollRunDraftOrApprove(
  session: AuthSession,
  input: {
    jobId: string;
    weekStartDate: string;
    approve: boolean;
    correctionReason?: string;
    adjustments?: Array<{
      workerId: string;
      kind: PayrollAdjustment["kind"];
      description: string;
      amountCents: number;
    }>;
  },
): Promise<PayrollRun> {
  if (!can(session.role, "payroll.view")) {
    throw new Error("Access denied: Supervisors cannot calculate or approve payroll.");
  }
  if (input.approve && !can(session.role, "payroll.approve")) {
    throw new Error("Only Management / Admin can approve a payroll week.");
  }

  let sourceToken='';let dataEpoch=1;
  if(session.mode==='supabase'){
    if(!supabase)throw new Error('Connection unavailable.');
    const source=await supabase.rpc('worktrack_payroll_source_token',{p_business:session.businessId,p_job:input.jobId,p_week:input.weekStartDate});
    if(source.error)throw new Error(source.error.message);sourceToken=source.data;
    const epoch=await supabase.from('businesses').select('data_epoch').eq('id',session.businessId).single();if(epoch.error)throw new Error(epoch.error.message);dataEpoch=Number(epoch.data.data_epoch);
  }
  const [bundle, att, existingRuns] = await Promise.all([
    listWorkforceBundle(session),
    listAttendanceForWeek(session, input.jobId, input.weekStartDate),
    listPayrollRuns(session, input.jobId),
  ]);

  const weekRuns = existingRuns.filter((r) => r.weekStartDate === input.weekStartDate);
  const approvedPrior = weekRuns.find((r) => r.status === "approved");
  if (approvedPrior && !input.correctionReason?.trim()) {
    throw new Error(
      "An approved payroll run already exists for this week. Enter a correction reason to create a new revision.",
    );
  }

  const now = new Date().toISOString();
  const runId = newId("prun");
  const mappedAdjustments: PayrollAdjustment[] = (input.adjustments ?? []).map((a) => ({
    id: newId("padj"),
    businessId: session.businessId,
    payrollRunId: runId,
    workerId: a.workerId,
    kind: a.kind,
    description: a.description.trim(),
    amountCents: a.amountCents,
    approvedByEmail: session.email,
    createdAt: now,
  }));

  const calc = calculatePayrollWeek({
    weekStartDate: input.weekStartDate,
    jobId: input.jobId,
    workers: bundle.workers,
    roles: bundle.roles,
    assignments: bundle.assignments,
    payRules: bundle.payRules,
    rateOverrides: bundle.rateOverrides,
    teamDays: att.teamDays,
    attendanceEntries: att.attendanceEntries,
    adjustments: mappedAdjustments,
    requireConfirmedRatesForApproval: true,
  });

  if (input.approve && !calc.canApprove) {
    throw new Error(`Cannot approve payroll: ${calc.blockingReasons[0] ?? "Blocking validation issues remain."}`);
  }

  const nextRevision =
    weekRuns.length > 0 ? Math.max(...weekRuns.map((r) => r.revision)) + 1 : 1;

  const newRun: PayrollRun = {
    id: runId,
    businessId: session.businessId,
    jobId: input.jobId,
    weekStartDate: calc.weekStartDate,
    weekEndDate: calc.weekEndDate,
    revision: nextRevision,
    status: input.approve ? "approved" : "draft",
    grossTotalCents: calc.grossTotalCents,
    adjustmentsTotalCents: calc.adjustmentsTotalCents,
    deductionsTotalCents: calc.deductionsTotalCents,
    netTotalCents: calc.netTotalCents,
    earnings: calc.earnings,
    adjustments: mappedAdjustments,
    approvedByEmail: input.approve ? session.email : null,
    approvedAt: input.approve ? now : null,
    correctionReason: input.correctionReason?.trim() || null,
    supersedesRunId: approvedPrior?.id ?? null,
    createdByEmail: session.email,
    createdAt: now,
  };

  if (isSupabaseConfigured && supabase && session.mode === "supabase") {
    const {data,error}=await supabase.rpc('worktrack_save_payroll',{
      p_business:session.businessId,p_epoch:dataEpoch,p_source_token:sourceToken,p_expected_revision:nextRevision-1,p_approve:input.approve,
      p_run:encodeRow(newRun as unknown as Record<string,unknown>,{key:'',table:''}),
      p_earnings:newRun.earnings.map(e=>encodeRow(e as unknown as Record<string,unknown>,{key:'',table:''})),
      p_adjustments:mappedAdjustments.map(a=>encodeRow(a as unknown as Record<string,unknown>,{key:'',table:''})),
    });
    if(error)throw new Error(error.message);
    newRun.status=data.status;newRun.approvedAt=data.approved_at;newRun.approvedByEmail=data.approved_by_email;
    return newRun;
  }

  const store = loadStore();
  if (input.approve && approvedPrior) {
    const priorInStore = store.payrollRuns.find((r) => r.id === approvedPrior.id);
    if (priorInStore) priorInStore.status = "superseded";
  }
  store.payrollRuns.unshift(newRun);
  saveStore(store);
  return newRun;
}