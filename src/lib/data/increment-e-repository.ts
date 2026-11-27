import type { AuthSession } from "@/lib/domain/types";
import type {
  AssetCheck,
  AssetDefect,
  AssetRecord,
  AssetServiceEntry,
  AssetType,
  CheckItemResult,
  IncrementEBundle,
  NotificationPreferences,
  NotificationRecord,
  PreUseCheckItemKey,
  WeeklyReport,
  WeeklyReportSnapshot,
} from "@/lib/domain/increment-e-types";
import { evaluatePreUseCheck } from "@/lib/domain/increment-e-calc";
import { assertBusinessBoundary, can } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";
import { SYNTHETIC_BIZ_A, SYNTHETIC_BIZ_B, SYNTHETIC_JOB_1 } from "@/lib/data/synthetic-fixtures";

const STORAGE_KEY = "worktrack.synthetic.increment_e.v1";

interface SyntheticIncrementEStore {
  assets: AssetRecord[];
  checks: AssetCheck[];
  defects: AssetDefect[];
  services: AssetServiceEntry[];
  reports: WeeklyReport[];
  notifications: NotificationRecord[];
  preferences: NotificationPreferences[];
}

function createInitialStore(): SyntheticIncrementEStore {
  const now = "2026-11-27T07:30:00.000Z";
  return {
    assets: [
      {
        id: "asset-truck-1",
        businessId: SYNTHETIC_BIZ_A,
        assetType: "truck",
        name: "Crew Truck 01 (Synthetic)",
        makeModel: "Isuzu NQR 500 Dropside",
        registration: "CA 412-908 (SYN)",
        vin: "SYN-VIN-NQR500-00101",
        ownerName: "Karoo Verge Clearing (Synthetic Dev)",
        purchaseCostCents: 38500000,
        odometerKm: 148250,
        serviceIntervalKm: 15000,
        lastServiceOdometerKm: 140000,
        licenceExpiryDate: "2027-03-31",
        insuranceExpiryDate: "2027-06-30",
        assignedJobId: SYNTHETIC_JOB_1,
        status: "available",
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "asset-bakkie-2",
        businessId: SYNTHETIC_BIZ_A,
        assetType: "bakkie",
        name: "Support Bakkie 02 (Synthetic)",
        makeModel: "Toyota Hilux 2.4 GD-6 Single Cab",
        registration: "CA 771-204 (SYN)",
        vin: "SYN-VIN-HILUX-00202",
        ownerName: "Karoo Verge Clearing (Synthetic Dev)",
        purchaseCostCents: 29500000,
        odometerKm: 92400,
        serviceIntervalKm: 10000,
        lastServiceOdometerKm: 90000,
        licenceExpiryDate: "2027-05-31",
        insuranceExpiryDate: "2027-05-31",
        assignedJobId: SYNTHETIC_JOB_1,
        status: "available",
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "asset-cutter-1",
        businessId: SYNTHETIC_BIZ_A,
        assetType: "brush_cutter",
        name: "Brush Cutter Fleet #01–#04",
        makeModel: "Stihl FS 250 (Synthetic)",
        registration: null,
        vin: null,
        ownerName: "Karoo Verge Clearing (Synthetic Dev)",
        purchaseCostCents: 3200000,
        odometerKm: null,
        serviceIntervalKm: null,
        lastServiceOdometerKm: null,
        licenceExpiryDate: null,
        insuranceExpiryDate: null,
        assignedJobId: SYNTHETIC_JOB_1,
        status: "available",
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "asset-other-biz",
        businessId: SYNTHETIC_BIZ_B,
        assetType: "truck",
        name: "Tenant B Truck",
        makeModel: "Hino 300",
        registration: "EC 999-000",
        vin: "SYN-TENANT-B-VIN",
        ownerName: "Eastern Cape Roads Demo",
        purchaseCostCents: 31000000,
        odometerKm: 80000,
        serviceIntervalKm: 15000,
        lastServiceOdometerKm: 75000,
        licenceExpiryDate: "2027-04-30",
        insuranceExpiryDate: "2027-04-30",
        assignedJobId: null,
        status: "available",
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    checks: [
      {
        id: "chk-seed-1",
        businessId: SYNTHETIC_BIZ_A,
        assetId: "asset-truck-1",
        jobId: SYNTHETIC_JOB_1,
        checkDate: "2026-11-26",
        odometerKm: 148120,
        items: {
          oil: "ok",
          coolant: "ok",
          leaks: "ok",
          tyres: "ok",
          brakes_lights: "ok",
          warning_lights: "ok",
        },
        stopUseTriggered: false,
        failedCriticalItems: [],
        comment: "Morning pre-start check passed.",
        photoNote: null,
        capturedOffline: false,
        syncStatus: "synced",
        checkedByUserId: "u-owner-a",
        checkedByName: "Sipho Mokoena (Synthetic Owner)",
        createdAt: "2026-11-26T05:15:00.000Z",
      },
    ],
    defects: [],
    services: [
      {
        id: "svc-fuel-1",
        businessId: SYNTHETIC_BIZ_A,
        assetId: "asset-truck-1",
        entryDate: "2026-11-18",
        entryType: "fuel",
        odometerKm: 147650,
        litres: 92,
        costCents: 211600,
        description: "Diesel fill-up (Synthetic)",
        createdBy: "owner@synthetic.worktrack.local",
        createdAt: "2026-11-18T14:00:00.000Z",
      },
      {
        id: "svc-fuel-2",
        businessId: SYNTHETIC_BIZ_A,
        assetId: "asset-truck-1",
        entryDate: "2026-11-25",
        entryType: "fuel",
        odometerKm: 148250,
        litres: 108,
        costCents: 248400,
        description: "Diesel fill-up (Synthetic)",
        createdBy: "owner@synthetic.worktrack.local",
        createdAt: "2026-11-25T15:00:00.000Z",
      },
    ],
    reports: [],
    notifications: [],
    preferences: [
      {
        businessId: SYNTHETIC_BIZ_A,
        weeklyReportReminderDay: "sunday",
        weeklyReportReminderTimeSAST: "17:00",
        largeExpenseThresholdCents: 500000, // R 5 000.00 configurable
        cashShortfallAlertEnabled: true,
        missingReceiptAlertEnabled: true,
        smtpDigestEnabled: false,
        smtpConfigured: false,
        updatedAt: now,
      },
      {
        businessId: SYNTHETIC_BIZ_B,
        weeklyReportReminderDay: "sunday",
        weeklyReportReminderTimeSAST: "17:00",
        largeExpenseThresholdCents: 500000,
        cashShortfallAlertEnabled: true,
        missingReceiptAlertEnabled: true,
        smtpDigestEnabled: false,
        smtpConfigured: false,
        updatedAt: now,
      },
    ],
  };
}

let memoryStore: SyntheticIncrementEStore | null = null;

function loadStore(): SyntheticIncrementEStore {
  if (typeof window !== "undefined" && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as SyntheticIncrementEStore;
      } catch {
        // fall through
      }
    }
    const fresh = createInitialStore();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }
  if (!memoryStore) memoryStore = createInitialStore();
  return memoryStore;
}

function saveStore(store: SyntheticIncrementEStore): void {
  memoryStore = store;
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }
}

export function resetSyntheticIncrementEStore(): void {
  memoryStore = createInitialStore();
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

function sanitizeAssetForRole(asset: AssetRecord, session: AuthSession): AssetRecord {
  if (can(session.role, "vehicles.view_vin")) return asset;
  return {
    ...asset,
    vin: null,
    purchaseCostCents: null,
  };
}

export async function listIncrementEBundle(session: AuthSession): Promise<IncrementEBundle> {
  const sb = supabase;
  if (sb && session.mode === "supabase") {
    // Live Supabase path — queries tables from migration 202611270006
    const [assetsRes, checksRes, defectsRes, servicesRes, reportsRes, notifsRes, prefsRes] =
      await Promise.all([
        sb.from("assets").select("*").eq("business_id", session.businessId),
        sb.from("asset_checks").select("*").eq("business_id", session.businessId),
        sb.from("defects").select("*").eq("business_id", session.businessId),
        sb.from("asset_services").select("*").eq("business_id", session.businessId),
        sb.from("weekly_reports").select("*").eq("business_id", session.businessId),
        sb.from("notifications").select("*").eq("business_id", session.businessId),
        sb
          .from("notification_preferences")
          .select("*")
          .eq("business_id", session.businessId)
          .maybeSingle(),
      ]);
    if (assetsRes.error) throw new Error(assetsRes.error.message);
    if (checksRes.error) throw new Error(checksRes.error.message);
    if (defectsRes.error) throw new Error(defectsRes.error.message);
    if (servicesRes.error) throw new Error(servicesRes.error.message);
    if (reportsRes.error) throw new Error(reportsRes.error.message);
    if (notifsRes.error) throw new Error(notifsRes.error.message);

    const prefs: NotificationPreferences = prefsRes.data
      ? {
          businessId: session.businessId,
          weeklyReportReminderDay: prefsRes.data.weekly_report_reminder_day,
          weeklyReportReminderTimeSAST: prefsRes.data.weekly_report_reminder_time_sast,
          largeExpenseThresholdCents: Number(prefsRes.data.large_expense_threshold_cents),
          cashShortfallAlertEnabled: Boolean(prefsRes.data.cash_shortfall_alert_enabled),
          missingReceiptAlertEnabled: Boolean(prefsRes.data.missing_receipt_alert_enabled),
          smtpDigestEnabled: Boolean(prefsRes.data.smtp_digest_enabled),
          smtpConfigured: Boolean(prefsRes.data.smtp_configured),
          updatedAt: prefsRes.data.updated_at,
        }
      : createInitialStore().preferences[0]!;

    return {
      assets: (assetsRes.data ?? []).map((r: any) =>
        sanitizeAssetForRole(
          {
            id: r.id,
            businessId: r.business_id,
            assetType: r.asset_type,
            name: r.name,
            makeModel: r.make_model,
            registration: r.registration,
            vin: r.vin,
            ownerName: r.owner_name,
            purchaseCostCents: r.purchase_cost_cents !== null ? Number(r.purchase_cost_cents) : null,
            odometerKm: r.odometer_km !== null ? Number(r.odometer_km) : null,
            serviceIntervalKm: r.service_interval_km !== null ? Number(r.service_interval_km) : null,
            lastServiceOdometerKm:
              r.last_service_odometer_km !== null ? Number(r.last_service_odometer_km) : null,
            licenceExpiryDate: r.licence_expiry_date,
            insuranceExpiryDate: r.insurance_expiry_date,
            assignedJobId: r.assigned_job_id,
            status: r.status,
            active: Boolean(r.active),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          },
          session,
        ),
      ),
      checks: (checksRes.data ?? []).map((c: any) => ({
        id: c.id,
        businessId: c.business_id,
        assetId: c.asset_id,
        jobId: c.job_id,
        checkDate: c.check_date,
        odometerKm: c.odometer_km !== null ? Number(c.odometer_km) : null,
        items: c.items,
        stopUseTriggered: Boolean(c.stop_use_triggered),
        failedCriticalItems: c.failed_critical_items ?? [],
        comment: c.comment ?? "",
        photoNote: c.photo_note,
        capturedOffline: Boolean(c.captured_offline),
        syncStatus: c.sync_status,
        checkedByUserId: c.checked_by_user_id,
        checkedByName: c.checked_by_name,
        createdAt: c.created_at,
      })),
      defects: (defectsRes.data ?? []).map((d: any) => ({
        id: d.id,
        businessId: d.business_id,
        assetId: d.asset_id,
        checkId: d.check_id,
        severity: d.severity,
        summary: d.summary,
        reportedDate: d.reported_date,
        reportedByUserId: d.reported_by_user_id,
        reportedByName: d.reported_by_name,
        status: d.status,
        resolutionNotes: d.resolution_notes,
        resolvedByUserId: d.resolved_by_user_id,
        resolvedByName: d.resolved_by_name,
        resolvedAt: d.resolved_at,
        createdAt: d.created_at,
      })),
      services: (servicesRes.data ?? []).map((s: any) => ({
        id: s.id,
        businessId: s.business_id,
        assetId: s.asset_id,
        entryDate: s.entry_date,
        entryType: s.entry_type,
        odometerKm: s.odometer_km !== null ? Number(s.odometer_km) : null,
        litres: s.litres !== null ? Number(s.litres) : null,
        costCents: Number(s.cost_cents),
        description: s.description,
        createdBy: s.created_by,
        createdAt: s.created_at,
      })),
      reports: (reportsRes.data ?? []).map((r: any) => ({
        id: r.id,
        businessId: r.business_id,
        jobId: r.job_id,
        weekStart: r.week_start,
        weekEnd: r.week_end,
        status: r.status,
        currentRevision: Number(r.current_revision),
        lockedSnapshot: r.locked_snapshot,
        latestComment: r.latest_comment,
        missingEvidenceAcknowledged: Boolean(r.missing_evidence_acknowledged),
        submittedBy: r.submitted_by,
        submittedAt: r.submitted_at,
        reviewedBy: r.reviewed_by,
        reviewedAt: r.reviewed_at,
        revisions: r.revisions_json ?? [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      notifications: (notifsRes.data ?? []).map((n: any) => ({
        id: n.id,
        businessId: n.business_id,
        type: n.type,
        severity: n.severity,
        title: n.title,
        body: n.body,
        dedupKey: n.dedup_key,
        linkTo: n.link_to,
        readAt: n.read_at,
        acknowledgedAt: n.acknowledged_at,
        acknowledgedBy: n.acknowledged_by,
        deliveryChannel: n.delivery_channel,
        createdAt: n.created_at,
      })),
      preferences: prefs,
    };
  }

  const store = loadStore();
  const prefs =
    store.preferences.find((p) => p.businessId === session.businessId) ?? {
      ...createInitialStore().preferences[0]!,
      businessId: session.businessId,
    };

  const visibleReports = store.reports.filter((r) => {
    if (r.businessId !== session.businessId) return false;
    if (session.role === "supervisor") {
      return session.assignedJobIds.includes(r.jobId);
    }
    return true;
  });

  return {
    assets: store.assets
      .filter((a) => a.businessId === session.businessId)
      .map((a) => sanitizeAssetForRole(a, session)),
    checks: store.checks
      .filter((c) => c.businessId === session.businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    defects: store.defects
      .filter((d) => d.businessId === session.businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    services: store.services
      .filter((s) => s.businessId === session.businessId)
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
    reports: visibleReports.sort((a, b) => b.weekStart.localeCompare(a.weekStart)),
    notifications: store.notifications
      .filter((n) => n.businessId === session.businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    preferences: prefs,
  };
}

export async function createAsset(
  session: AuthSession,
  input: {
    assetType: AssetType;
    name: string;
    makeModel: string;
    registration: string | null;
    vin: string | null;
    ownerName: string;
    purchaseCostCents: number | null;
    odometerKm: number | null;
    serviceIntervalKm: number | null;
    licenceExpiryDate: string | null;
    insuranceExpiryDate: string | null;
    assignedJobId: string | null;
  },
): Promise<AssetRecord> {
  if (!can(session.role, "vehicles.manage")) {
    throw new Error("Access denied: only Admin or Owner can add vehicles or equipment.");
  }
  if (!input.name.trim() || !input.makeModel.trim()) {
    throw new Error("Asset name and make/model are required.");
  }
  if (input.odometerKm !== null && input.odometerKm < 0) {
    throw new Error("Odometer reading cannot be negative.");
  }
  const now = new Date().toISOString();
  const record: AssetRecord = {
    id: `asset-${crypto.randomUUID().slice(0, 8)}`,
    businessId: session.businessId,
    assetType: input.assetType,
    name: input.name.trim(),
    makeModel: input.makeModel.trim(),
    registration: input.registration?.trim() || null,
    vin: input.vin?.trim() || null,
    ownerName: input.ownerName.trim() || session.businessName,
    purchaseCostCents: input.purchaseCostCents,
    odometerKm: input.odometerKm,
    serviceIntervalKm: input.serviceIntervalKm,
    lastServiceOdometerKm: input.odometerKm,
    licenceExpiryDate: input.licenceExpiryDate,
    insuranceExpiryDate: input.insuranceExpiryDate,
    assignedJobId: input.assignedJobId,
    status: "available",
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  const store = loadStore();
  store.assets.unshift(record);
  saveStore(store);
  return record;
}

export async function recordPreUseCheck(
  session: AuthSession,
  input: {
    assetId: string;
    jobId: string | null;
    checkDate: string;
    odometerKm: number | null;
    items: Record<PreUseCheckItemKey, CheckItemResult>;
    comment: string;
    photoNote: string | null;
    isOffline?: boolean;
    idempotencyKey?: string;
  },
): Promise<{ check: AssetCheck; defect: AssetDefect | null; notification: NotificationRecord | null }> {
  if (!can(session.role, "vehicles.check")) {
    throw new Error("Access denied: you cannot record vehicle safety checks.");
  }
  if (input.odometerKm !== null && input.odometerKm < 0) {
    throw new Error("Odometer reading cannot be negative.");
  }

  const store = loadStore();
  if (input.idempotencyKey) {
    const existingCheck = store.checks.find(
      (c) => c.businessId === session.businessId && c.idempotencyKey === input.idempotencyKey,
    );
    if (existingCheck) {
      const existingDefect =
        store.defects.find((d) => d.checkId === existingCheck.id) ?? null;
      const existingNotification = existingDefect
        ? (store.notifications.find((n) => n.dedupKey === `defect:${existingDefect.id}`) ?? null)
        : null;
      return {
        check: existingCheck,
        defect: existingDefect,
        notification: existingNotification,
      };
    }
  }
  const asset = store.assets.find((a) => a.id === input.assetId);
  if (!asset) throw new Error("Vehicle or equipment not found.");
  assertBusinessBoundary(session, asset.businessId, "vehicle");

  const evaluation = evaluatePreUseCheck(input.items);
  const now = new Date().toISOString();
  const offline = Boolean(input.isOffline);

  const check: AssetCheck = {
    id: `chk-${crypto.randomUUID().slice(0, 8)}`,
    businessId: session.businessId,
    assetId: asset.id,
    jobId: input.jobId,
    checkDate: input.checkDate,
    odometerKm: input.odometerKm,
    items: input.items,
    stopUseTriggered: evaluation.stopUseTriggered,
    failedCriticalItems: evaluation.failedCriticalItems,
    comment: input.comment.trim(),
    photoNote: input.photoNote?.trim() || null,
    capturedOffline: offline,
    syncStatus: offline ? "queued_offline" : "synced",
    checkedByUserId: session.userId,
    checkedByName: session.fullName,
    createdAt: now,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
  store.checks.unshift(check);

  if (input.odometerKm !== null && (asset.odometerKm === null || input.odometerKm >= asset.odometerKm)) {
    asset.odometerKm = input.odometerKm;
  }

  let defect: AssetDefect | null = null;
  let notification: NotificationRecord | null = null;

  if (evaluation.stopUseTriggered) {
    asset.status = "unavailable_defect";
    asset.updatedAt = now;

    defect = {
      id: `def-${crypto.randomUUID().slice(0, 8)}`,
      businessId: session.businessId,
      assetId: asset.id,
      checkId: check.id,
      severity: "critical",
      summary: `${asset.name}: ${evaluation.summary}${input.comment.trim() ? ` — ${input.comment.trim()}` : ""}`,
      reportedDate: input.checkDate,
      reportedByUserId: session.userId,
      reportedByName: session.fullName,
      status: "open",
      resolutionNotes: null,
      resolvedByUserId: null,
      resolvedByName: null,
      resolvedAt: null,
      createdAt: now,
    };
    store.defects.unshift(defect);

    const dedupKey = `defect:${defect.id}`;
    notification = {
      id: `notif-${crypto.randomUUID().slice(0, 8)}`,
      businessId: session.businessId,
      type: "vehicle_stop_use",
      severity: "critical",
      title: `STOP DO NOT USE — ${asset.name}`,
      body: `${evaluation.summary}. Marked unavailable${offline ? " (queued offline for sync)" : ""}.`,
      dedupKey,
      linkTo: "/vehicles",
      readAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      deliveryChannel: "in_app_and_smtp_queued",
      createdAt: now,
    };
    store.notifications.unshift(notification);
  }

  saveStore(store);
  return { check, defect, notification };
}

export async function resolveAssetDefect(
  session: AuthSession,
  defectId: string,
  resolutionNotes: string,
): Promise<AssetDefect> {
  if (!can(session.role, "vehicles.resolve_defect")) {
    throw new Error("Access denied: only Management / Admin or Owner can clear a STOP DO NOT USE defect.");
  }
  if (!resolutionNotes.trim()) {
    throw new Error("Resolution notes are required before returning the vehicle to service.");
  }

  const store = loadStore();
  const defect = store.defects.find((d) => d.id === defectId);
  if (!defect) throw new Error("Defect not found.");
  assertBusinessBoundary(session, defect.businessId, "defect");

  const now = new Date().toISOString();
  defect.status = "resolved";
  defect.resolutionNotes = resolutionNotes.trim();
  defect.resolvedByUserId = session.userId;
  defect.resolvedByName = session.fullName;
  defect.resolvedAt = now;

  const stillOpenCritical = store.defects.some(
    (d) => d.assetId === defect.assetId && d.status === "open" && d.severity === "critical",
  );
  const asset = store.assets.find((a) => a.id === defect.assetId);
  if (asset && !stillOpenCritical && asset.status === "unavailable_defect") {
    asset.status = "available";
    asset.updatedAt = now;
  }

  saveStore(store);
  return defect;
}

export async function recordAssetServiceEntry(
  session: AuthSession,
  input: {
    assetId: string;
    entryDate: string;
    entryType: "service" | "repair" | "fuel";
    odometerKm: number | null;
    litres: number | null;
    costCents: number;
    description: string;
  },
): Promise<AssetServiceEntry> {
  if (!can(session.role, "vehicles.manage")) {
    throw new Error("Access denied: only Admin or Owner can log vehicle service or fuel entries.");
  }
  if (input.costCents < 0) throw new Error("Cost cannot be negative.");
  if (!input.description.trim()) throw new Error("Description is required.");

  const store = loadStore();
  const asset = store.assets.find((a) => a.id === input.assetId);
  if (!asset) throw new Error("Asset not found.");
  assertBusinessBoundary(session, asset.businessId, "asset");

  const now = new Date().toISOString();
  const entry: AssetServiceEntry = {
    id: `svc-${crypto.randomUUID().slice(0, 8)}`,
    businessId: session.businessId,
    assetId: asset.id,
    entryDate: input.entryDate,
    entryType: input.entryType,
    odometerKm: input.odometerKm,
    litres: input.litres,
    costCents: Math.round(input.costCents),
    description: input.description.trim(),
    createdBy: session.email,
    createdAt: now,
  };
  store.services.unshift(entry);
  if (input.odometerKm !== null && (asset.odometerKm === null || input.odometerKm >= asset.odometerKm)) {
    asset.odometerKm = input.odometerKm;
  }
  if (input.entryType === "service" && input.odometerKm !== null) {
    asset.lastServiceOdometerKm = input.odometerKm;
  }
  asset.updatedAt = now;
  saveStore(store);
  return entry;
}

/**
 * Submit a weekly job report (Owner or Admin).
 * Creates revision 1 if new, or increments revision when resubmitting a returned or amended report.
 */
export async function submitWeeklyReport(
  session: AuthSession,
  params: {
    snapshot: WeeklyReportSnapshot;
    missingEvidenceAcknowledged: boolean;
    comment?: string;
  },
): Promise<WeeklyReport> {
  if (!can(session.role, "reports.submit")) {
    throw new Error("Access denied: Supervisors cannot submit weekly reports.");
  }
  const { snapshot, missingEvidenceAcknowledged } = params;
  if (
    (snapshot.missingReceiptsCount > 0 || snapshot.truckChecksCount === 0) &&
    !missingEvidenceAcknowledged
  ) {
    throw new Error(
      "Please acknowledge missing receipts or truck checks before submitting this weekly report.",
    );
  }

  const store = loadStore();
  const now = new Date().toISOString();
  let report = store.reports.find(
    (r) =>
      r.businessId === session.businessId &&
      r.jobId === snapshot.jobId &&
      r.weekStart === snapshot.weekStart,
  );

  if (report && report.status === "approved") {
    throw new Error(
      "Approved weekly reports are locked. Start an amendment revision before resubmitting.",
    );
  }

  if (!report) {
    report = {
      id: `wrep-${crypto.randomUUID().slice(0, 8)}`,
      businessId: session.businessId,
      jobId: snapshot.jobId,
      weekStart: snapshot.weekStart,
      weekEnd: snapshot.weekEnd,
      status: "submitted",
      currentRevision: 1,
      lockedSnapshot: null,
      latestComment: params.comment?.trim() || null,
      missingEvidenceAcknowledged,
      submittedBy: session.fullName,
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      revisions: [],
      createdAt: now,
      updatedAt: now,
    };
    store.reports.unshift(report);
  } else {
    report.currentRevision += 1;
    report.status = "submitted";
    report.latestComment = params.comment?.trim() || null;
    report.missingEvidenceAcknowledged = missingEvidenceAcknowledged;
    report.submittedBy = session.fullName;
    report.submittedAt = now;
    report.updatedAt = now;
  }

  report.revisions.push({
    id: `wrev-${crypto.randomUUID().slice(0, 8)}`,
    reportId: report.id,
    revisionNumber: report.currentRevision,
    status: "submitted",
    snapshot,
    actorUserId: session.userId,
    actorName: session.fullName,
    comment: params.comment?.trim() || null,
    missingEvidenceAcknowledged,
    createdAt: now,
  });

  saveStore(store);
  return report;
}

export async function returnWeeklyReport(
  session: AuthSession,
  reportId: string,
  comment: string,
): Promise<WeeklyReport> {
  if (!can(session.role, "reports.approve")) {
    throw new Error("Access denied: only Management / Admin can return a weekly report.");
  }
  if (!comment.trim()) {
    throw new Error("Please enter specific comments explaining what must be fixed.");
  }

  const store = loadStore();
  const report = store.reports.find((r) => r.id === reportId);
  if (!report) throw new Error("Weekly report not found.");
  assertBusinessBoundary(session, report.businessId, "weekly report");
  if (report.status !== "submitted") {
    throw new Error("Only submitted weekly reports can be returned.");
  }

  const now = new Date().toISOString();
  const latestSnap = report.revisions[report.revisions.length - 1]?.snapshot;
  if (!latestSnap) throw new Error("Report snapshot missing.");

  report.status = "returned";
  report.latestComment = comment.trim();
  report.reviewedBy = session.fullName;
  report.reviewedAt = now;
  report.updatedAt = now;
  report.revisions.push({
    id: `wrev-${crypto.randomUUID().slice(0, 8)}`,
    reportId: report.id,
    revisionNumber: report.currentRevision,
    status: "returned",
    snapshot: latestSnap,
    actorUserId: session.userId,
    actorName: session.fullName,
    comment: comment.trim(),
    missingEvidenceAcknowledged: report.missingEvidenceAcknowledged,
    createdAt: now,
  });

  saveStore(store);
  return report;
}

export async function approveWeeklyReport(
  session: AuthSession,
  reportId: string,
  comment?: string,
): Promise<WeeklyReport> {
  if (!can(session.role, "reports.approve")) {
    throw new Error("Access denied: only Management / Admin can approve a weekly report.");
  }

  const store = loadStore();
  const report = store.reports.find((r) => r.id === reportId);
  if (!report) throw new Error("Weekly report not found.");
  assertBusinessBoundary(session, report.businessId, "weekly report");
  if (report.status !== "submitted") {
    throw new Error("Only submitted weekly reports can be approved.");
  }

  const now = new Date().toISOString();
  const latestSnap = report.revisions[report.revisions.length - 1]?.snapshot;
  if (!latestSnap) throw new Error("Report snapshot missing.");

  report.status = "approved";
  report.lockedSnapshot = JSON.parse(JSON.stringify(latestSnap)) as WeeklyReportSnapshot;
  report.latestComment = comment?.trim() || "Approved and locked.";
  report.reviewedBy = session.fullName;
  report.reviewedAt = now;
  report.updatedAt = now;
  report.revisions.push({
    id: `wrev-${crypto.randomUUID().slice(0, 8)}`,
    reportId: report.id,
    revisionNumber: report.currentRevision,
    status: "approved",
    snapshot: report.lockedSnapshot,
    actorUserId: session.userId,
    actorName: session.fullName,
    comment: report.latestComment,
    missingEvidenceAcknowledged: report.missingEvidenceAcknowledged,
    createdAt: now,
  });

  saveStore(store);
  return report;
}

export async function startWeeklyReportAmendment(
  session: AuthSession,
  reportId: string,
  reason: string,
): Promise<WeeklyReport> {
  if (!can(session.role, "reports.approve")) {
    throw new Error("Access denied: only Management / Admin can open an amendment on an approved report.");
  }
  if (!reason.trim()) {
    throw new Error("Please provide a documented reason for the amendment.");
  }
  const store = loadStore();
  const report = store.reports.find((r) => r.id === reportId);
  if (!report) throw new Error("Weekly report not found.");
  assertBusinessBoundary(session, report.businessId, "weekly report");
  if (report.status !== "approved") {
    throw new Error("Only approved reports require an amendment workflow.");
  }

  const now = new Date().toISOString();
  report.status = "draft";
  report.latestComment = `Amendment opened: ${reason.trim()}`;
  report.updatedAt = now;
  saveStore(store);
  return report;
}

export async function syncNotifications(
  session: AuthSession,
  evaluated: NotificationRecord[],
): Promise<NotificationRecord[]> {
  const store = loadStore();
  const otherBiz = store.notifications.filter((n) => n.businessId !== session.businessId);
  store.notifications = [...evaluated, ...otherBiz];
  saveStore(store);
  return evaluated;
}

export async function markNotificationReadOrAck(
  session: AuthSession,
  notificationId: string,
  acknowledge: boolean,
): Promise<void> {
  const store = loadStore();
  const notif = store.notifications.find((n) => n.id === notificationId);
  if (!notif) return;
  assertBusinessBoundary(session, notif.businessId, "notification");
  const now = new Date().toISOString();
  if (!notif.readAt) notif.readAt = now;
  if (acknowledge) {
    notif.acknowledgedAt = now;
    notif.acknowledgedBy = session.fullName;
  }
  saveStore(store);
}

export async function updateNotificationPreferences(
  session: AuthSession,
  patch: Partial<Omit<NotificationPreferences, "businessId" | "updatedAt">>,
): Promise<NotificationPreferences> {
  if (!can(session.role, "notifications.configure")) {
    throw new Error("Access denied: only Management / Admin can update notification preferences.");
  }
  const store = loadStore();
  const idx = store.preferences.findIndex((p) => p.businessId === session.businessId);
  const current =
    idx >= 0
      ? store.preferences[idx]!
      : { ...createInitialStore().preferences[0]!, businessId: session.businessId };
  const updated: NotificationPreferences = {
    ...current,
    ...patch,
    businessId: session.businessId,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    store.preferences[idx] = updated;
  } else {
    store.preferences.push(updated);
  }
  saveStore(store);
  return updated;
}