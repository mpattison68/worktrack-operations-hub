import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import {
  createInitialSyntheticState,
  type SyntheticStoreState,
} from "@/lib/data/synthetic-fixtures";
import type {
  AppRole,
  AuditEvent,
  AuthSession,
  Business,
  Invitation,
  Job,
  JobStatus,
  Membership,
  PayBasis,
  PayRule,
  VatBasis,
  Worker,
  WorkerAssignment,
  WorkerRateOverride,
  WorkerRole,
  WorkerRoleType,
} from "@/lib/domain/types";
import { assertBusinessBoundary, can, canAccessJob } from "@/lib/permissions";
import { validateJobInput, validatePayRuleCandidate } from "@/lib/domain/validation";

const STORAGE_KEY = "worktrack_synthetic_dev_v1";

function loadSyntheticStore(): SyntheticStoreState {
  if (typeof window === "undefined") return createInitialSyntheticState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const initial = createInitialSyntheticState();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
      return initial;
    }
    return JSON.parse(raw) as SyntheticStoreState;
  } catch {
    return createInitialSyntheticState();
  }
}

function saveSyntheticStore(state: SyntheticStoreState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetSyntheticStore(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(createInitialSyntheticState()));
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function appendSyntheticAudit(
  state: SyntheticStoreState,
  session: AuthSession,
  entityType: string,
  entityId: string,
  action: string,
  changedFields: Record<string, unknown>,
  reason: string | null = null,
): void {
  state.auditEvents.unshift({
    id: newId(),
    businessId: session.businessId,
    actorUserId: session.userId,
    actorEmail: session.email,
    entityType,
    entityId,
    action,
    reason,
    changedFields,
    createdAt: new Date().toISOString(),
  });
}

export function listSyntheticAccounts(): Array<Membership & { businessName: string }> {
  const state = loadSyntheticStore();
  return state.memberships.map((m) => ({
    ...m,
    businessName: state.businesses.find((b) => b.id === m.businessId)?.name ?? "Unknown business",
  }));
}

export async function getBusiness(session: AuthSession): Promise<Business> {
  if (!can(session.role, "business.view")) {
    throw new Error("Access denied: you do not have permission to view business settings.");
  }
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("businesses")
      .select("*")
      .eq("id", session.businessId)
      .single();
    if (error || !data) throw new Error(error?.message ?? "Business not found.");
    return {
      id: data.id,
      name: data.name,
      registrationNumber: data.registration_number,
      vatNumber: data.vat_number,
      defaultVatBasis: data.default_vat_basis,
      timezone: data.timezone,
      currency: data.currency,
      weekStartDay: 1,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
  const state = loadSyntheticStore();
  const biz = state.businesses.find((b) => b.id === session.businessId);
  if (!biz) throw new Error("Business not found.");
  return biz;
}

export async function updateBusiness(
  session: AuthSession,
  patch: {
    name: string;
    registrationNumber: string | null;
    vatNumber: string | null;
    defaultVatBasis: VatBasis;
  },
): Promise<Business> {
  if (!can(session.role, "business.edit")) {
    throw new Error("Access denied: only Management / Admin can edit business settings.");
  }
  if (!patch.name.trim()) throw new Error("Business name is required.");
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("businesses")
      .update({
        name: patch.name.trim(),
        registration_number: patch.registrationNumber?.trim() || null,
        vat_number: patch.vatNumber?.trim() || null,
        default_vat_basis: patch.defaultVatBasis,
      })
      .eq("id", session.businessId)
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to update business.");
    return {
      id: data.id,
      name: data.name,
      registrationNumber: data.registration_number,
      vatNumber: data.vat_number,
      defaultVatBasis: data.default_vat_basis,
      timezone: data.timezone,
      currency: data.currency,
      weekStartDay: 1,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
  const state = loadSyntheticStore();
  const idx = state.businesses.findIndex((b) => b.id === session.businessId);
  if (idx < 0) throw new Error("Business not found.");
  const current = state.businesses[idx]!;
  const updated: Business = {
    ...current,
    name: patch.name.trim(),
    registrationNumber: patch.registrationNumber?.trim() || null,
    vatNumber: patch.vatNumber?.trim() || null,
    defaultVatBasis: patch.defaultVatBasis,
    updatedAt: new Date().toISOString(),
  };
  state.businesses[idx] = updated;
  appendSyntheticAudit(state, session, "business", updated.id, "updated", patch);
  saveSyntheticStore(state);
  return updated;
}

export async function listMembershipsAndInvitations(
  session: AuthSession,
): Promise<{ memberships: Membership[]; invitations: Invitation[] }> {
  if (!can(session.role, "business.view")) {
    throw new Error("Access denied: you cannot view business members.");
  }
  if (isSupabaseConfigured && supabase) {
    const [{ data: mData, error: mErr }, { data: iData, error: iErr }] = await Promise.all([
      supabase.from("memberships").select("*").eq("business_id", session.businessId),
      supabase.from("invitations").select("*").eq("business_id", session.businessId),
    ]);
    if (mErr) throw new Error(mErr.message);
    if (iErr) throw new Error(iErr.message);
    return {
      memberships: (mData ?? []).map((m) => ({
        id: m.id,
        businessId: m.business_id,
        userId: m.user_id,
        email: m.email ?? "",
        fullName: m.full_name ?? m.email ?? "Member",
        role: m.role,
        active: m.active,
        assignedJobIds: m.assigned_job_ids ?? [],
        createdAt: m.created_at,
      })),
      invitations: (iData ?? []).map((i) => ({
        id: i.id,
        businessId: i.business_id,
        email: i.email,
        fullName: i.full_name,
        role: i.role,
        assignedJobIds: i.assigned_job_ids ?? [],
        status: i.status,
        invitedBy: i.invited_by_email ?? "",
        createdAt: i.created_at,
        expiresAt: i.expires_at,
      })),
    };
  }
  const state = loadSyntheticStore();
  return {
    memberships: state.memberships.filter((m) => m.businessId === session.businessId),
    invitations: state.invitations.filter((i) => i.businessId === session.businessId),
  };
}

export async function createInvitation(
  session: AuthSession,
  input: { email: string; fullName: string; role: AppRole; assignedJobIds: string[] },
): Promise<Invitation> {
  if (!can(session.role, "users.manage")) {
    throw new Error("Access denied: only Management / Admin can invite users.");
  }
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Enter a valid email address.");
  if (!input.fullName.trim()) throw new Error("Enter the person's full name.");
  const expiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("invitations")
      .insert({
        business_id: session.businessId,
        email,
        full_name: input.fullName.trim(),
        role: input.role,
        assigned_job_ids: input.assignedJobIds,
        invited_by: session.userId,
        invited_by_email: session.email,
        expires_at: expiresAt,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to create invitation.");
    return {
      id: data.id,
      businessId: data.business_id,
      email: data.email,
      fullName: data.full_name,
      role: data.role,
      assignedJobIds: data.assigned_job_ids ?? [],
      status: data.status,
      invitedBy: data.invited_by_email ?? session.email,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
    };
  }

  const state = loadSyntheticStore();
  const inv: Invitation = {
    id: newId(),
    businessId: session.businessId,
    email,
    fullName: input.fullName.trim(),
    role: input.role,
    assignedJobIds: input.assignedJobIds,
    status: "pending",
    invitedBy: session.email,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  state.invitations.unshift(inv);
  appendSyntheticAudit(state, session, "invitation", inv.id, "created", {
    email: inv.email,
    role: inv.role,
  });
  saveSyntheticStore(state);
  return inv;
}

export async function listJobs(session: AuthSession): Promise<Job[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("business_id", session.businessId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const mapped: Job[] = (data ?? []).map((j) => ({
      id: j.id,
      businessId: j.business_id,
      name: j.name,
      customerName: j.customer_name,
      contractReference: j.contract_reference,
      contractValueCents: Number(j.contract_value_cents),
      vatBasis: j.vat_basis,
      roadOrArea: j.road_or_area,
      status: j.status,
      plannedStartDate: j.planned_start_date,
      plannedEndDate: j.planned_end_date,
      actualStartDate: j.actual_start_date,
      actualEndDate: j.actual_end_date,
      openingCashAllocationCents: Number(j.opening_cash_allocation_cents),
      workRequirements: j.work_requirements ?? "",
      revision: j.revision,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    }));
    return mapped.filter((j) => canAccessJob(session, j.id, j.businessId));
  }
  const state = loadSyntheticStore();
  return state.jobs.filter((j) => canAccessJob(session, j.id, j.businessId));
}

export async function saveJob(
  session: AuthSession,
  input: {
    id?: string;
    name: string;
    customerName: string;
    contractReference: string;
    contractValueCents: number;
    vatBasis: VatBasis;
    roadOrArea: string;
    status: JobStatus;
    plannedStartDate: string | null;
    plannedEndDate: string | null;
    openingCashAllocationCents: number;
    workRequirements: string;
  },
): Promise<Job> {
  if (!can(session.role, "jobs.manage")) {
    throw new Error("Access denied: only Management / Admin can create or edit jobs.");
  }
  const err = validateJobInput(input);
  if (err) throw new Error(err);

  if (isSupabaseConfigured && supabase) {
    const payload = {
      business_id: session.businessId,
      name: input.name.trim(),
      customer_name: input.customerName.trim(),
      contract_reference: input.contractReference.trim(),
      contract_value_cents: input.contractValueCents,
      vat_basis: input.vatBasis,
      road_or_area: input.roadOrArea.trim(),
      status: input.status,
      planned_start_date: input.plannedStartDate,
      planned_end_date: input.plannedEndDate,
      opening_cash_allocation_cents: input.openingCashAllocationCents,
      work_requirements: input.workRequirements.trim(),
    };
    const query = input.id
      ? supabase
          .from("jobs")
          .update(payload)
          .eq("id", input.id)
          .eq("business_id", session.businessId)
          .select("*")
          .single()
      : supabase.from("jobs").insert({ ...payload, created_by: session.userId }).select("*").single();
    const { data, error } = await query;
    if (error || !data) throw new Error(error?.message ?? "Failed to save job.");
    return {
      id: data.id,
      businessId: data.business_id,
      name: data.name,
      customerName: data.customer_name,
      contractReference: data.contract_reference,
      contractValueCents: Number(data.contract_value_cents),
      vatBasis: data.vat_basis,
      roadOrArea: data.road_or_area,
      status: data.status,
      plannedStartDate: data.planned_start_date,
      plannedEndDate: data.planned_end_date,
      actualStartDate: data.actual_start_date,
      actualEndDate: data.actual_end_date,
      openingCashAllocationCents: Number(data.opening_cash_allocation_cents),
      workRequirements: data.work_requirements ?? "",
      revision: data.revision,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  const state = loadSyntheticStore();
  const now = new Date().toISOString();
  if (input.id) {
    const idx = state.jobs.findIndex((j) => j.id === input.id);
    if (idx < 0) throw new Error("Job not found.");
    const existing = state.jobs[idx]!;
    assertBusinessBoundary(session, existing.businessId, "job");
    const updated: Job = {
      ...existing,
      name: input.name.trim(),
      customerName: input.customerName.trim(),
      contractReference: input.contractReference.trim(),
      contractValueCents: input.contractValueCents,
      vatBasis: input.vatBasis,
      roadOrArea: input.roadOrArea.trim(),
      status: input.status,
      plannedStartDate: input.plannedStartDate,
      plannedEndDate: input.plannedEndDate,
      openingCashAllocationCents: input.openingCashAllocationCents,
      workRequirements: input.workRequirements.trim(),
      revision: existing.revision + 1,
      updatedAt: now,
    };
    state.jobs[idx] = updated;
    appendSyntheticAudit(state, session, "job", updated.id, "updated", {
      status: updated.status,
      revision: updated.revision,
    });
    saveSyntheticStore(state);
    return updated;
  }

  const created: Job = {
    id: newId(),
    businessId: session.businessId,
    name: input.name.trim(),
    customerName: input.customerName.trim(),
    contractReference: input.contractReference.trim(),
    contractValueCents: input.contractValueCents,
    vatBasis: input.vatBasis,
    roadOrArea: input.roadOrArea.trim(),
    status: input.status,
    plannedStartDate: input.plannedStartDate,
    plannedEndDate: input.plannedEndDate,
    actualStartDate: null,
    actualEndDate: null,
    openingCashAllocationCents: input.openingCashAllocationCents,
    workRequirements: input.workRequirements.trim(),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  state.jobs.unshift(created);
  appendSyntheticAudit(state, session, "job", created.id, "created", { name: created.name });
  saveSyntheticStore(state);
  return created;
}

export async function listWorkforceBundle(session: AuthSession): Promise<{
  roles: WorkerRole[];
  payRules: PayRule[];
  workers: Worker[];
  rateOverrides: WorkerRateOverride[];
  assignments: WorkerAssignment[];
}> {
  const canViewRates = can(session.role, "rates.view");
  const canViewAllWorkers = can(session.role, "workers.view_all");

  if (isSupabaseConfigured && supabase) {
    const [rolesRes, workersRes, assignRes, rulesRes, overridesRes] = await Promise.all([
      supabase.from("worker_roles").select("*").eq("business_id", session.businessId),
      supabase.from("workers").select("*").eq("business_id", session.businessId),
      supabase.from("worker_assignments").select("*").eq("business_id", session.businessId),
      canViewRates
        ? supabase
            .from("pay_rules")
            .select("*")
            .eq("business_id", session.businessId)
            .order("effective_from", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      canViewRates
        ? supabase.from("worker_rate_overrides").select("*").eq("business_id", session.businessId)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (rolesRes.error) throw new Error(rolesRes.error.message);
    if (workersRes.error) throw new Error(workersRes.error.message);
    if (assignRes.error) throw new Error(assignRes.error.message);
    if (rulesRes.error) throw new Error(rulesRes.error.message);
    if (overridesRes.error) throw new Error(overridesRes.error.message);

    const assignments: WorkerAssignment[] = (assignRes.data ?? []).map((a) => ({
      id: a.id,
      businessId: a.business_id,
      workerId: a.worker_id,
      jobId: a.job_id,
      assignedFrom: a.assigned_from,
      assignedTo: a.assigned_to,
      active: a.active,
    }));
    const visibleAssignments = canViewAllWorkers
      ? assignments
      : assignments.filter((a) => session.assignedJobIds.includes(a.jobId));
    const assignedWorkerIds = new Set(visibleAssignments.map((a) => a.workerId));

    return {
      roles: (rolesRes.data ?? []).map((r) => ({
        id: r.id,
        businessId: r.business_id,
        roleType: r.role_type,
        name: r.name,
        sharesCrewSchedule: r.shares_crew_schedule,
        active: r.active,
        createdAt: r.created_at,
      })),
      payRules: (rulesRes.data ?? []).map((p) => ({
        id: p.id,
        businessId: p.business_id,
        workerRoleId: p.worker_role_id,
        payBasis: p.pay_basis,
        baseRateCents: Number(p.base_rate_cents),
        normalHoursPerDay: Number(p.normal_hours_per_day),
        normalWorkdaysPerWeek: Number(p.normal_workdays_per_week),
        weekdayOtHourlyCents:
          p.weekday_ot_hourly_cents === null ? null : Number(p.weekday_ot_hourly_cents),
        saturdayRateCents: p.saturday_rate_cents === null ? null : Number(p.saturday_rate_cents),
        sundayRateCents: p.sunday_rate_cents === null ? null : Number(p.sunday_rate_cents),
        publicHolidayRateCents:
          p.public_holiday_rate_cents === null ? null : Number(p.public_holiday_rate_cents),
        weeklyProrationPolicy: p.weekly_proration_policy,
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        isConfirmed: p.is_confirmed,
        notes: p.notes ?? "",
        createdAt: p.created_at,
      })),
      workers: (workersRes.data ?? [])
        .map((w) => ({
          id: w.id,
          businessId: w.business_id,
          fullName: w.full_name,
          contactPhone: w.contact_phone,
          workerRoleId: w.worker_role_id,
          employmentStartDate: w.employment_start_date,
          employmentEndDate: w.employment_end_date,
          active: w.active,
          openingBalanceCents: canViewRates ? Number(w.opening_balance_cents) : 0,
          openingBalanceSource: canViewRates ? (w.opening_balance_source ?? "") : "",
          openingBalanceVerified: w.opening_balance_verified,
          createdAt: w.created_at,
          updatedAt: w.updated_at,
        }))
        .filter((w) => canViewAllWorkers || assignedWorkerIds.has(w.id)),
      rateOverrides: (overridesRes.data ?? []).map((o) => ({
        id: o.id,
        businessId: o.business_id,
        workerId: o.worker_id,
        payBasis: o.pay_basis,
        proposedRateCents: Number(o.proposed_rate_cents),
        effectiveFrom: o.effective_from,
        effectiveTo: o.effective_to,
        reason: o.reason,
        status: o.status,
        requestedBy: o.requested_by_email ?? "",
        reviewedBy: o.reviewed_by_email ?? null,
        createdAt: o.created_at,
      })),
      assignments: visibleAssignments,
    };
  }

  const state = loadSyntheticStore();
  const bizAssignments = state.assignments.filter((a) => a.businessId === session.businessId);
  const visibleAssignments = canViewAllWorkers
    ? bizAssignments
    : bizAssignments.filter((a) => session.assignedJobIds.includes(a.jobId));
  const assignedWorkerIds = new Set(visibleAssignments.map((a) => a.workerId));

  return {
    roles: state.workerRoles.filter((r) => r.businessId === session.businessId),
    payRules: canViewRates
      ? state.payRules.filter((p) => p.businessId === session.businessId)
      : [],
    workers: state.workers
      .filter((w) => w.businessId === session.businessId)
      .filter((w) => canViewAllWorkers || assignedWorkerIds.has(w.id))
      .map((w) =>
        canViewRates ? w : { ...w, openingBalanceCents: 0, openingBalanceSource: "Restricted" },
      ),
    rateOverrides: canViewRates
      ? state.rateOverrides.filter((o) => o.businessId === session.businessId)
      : [],
    assignments: visibleAssignments,
  };
}

export async function createWorkerRole(
  session: AuthSession,
  input: { roleType: WorkerRoleType; name: string; sharesCrewSchedule: boolean },
): Promise<WorkerRole> {
  if (!can(session.role, "rates.edit")) {
    throw new Error("Access denied: only Management / Admin can create worker roles.");
  }
  if (!input.name.trim()) throw new Error("Role name is required.");
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("worker_roles")
      .insert({
        business_id: session.businessId,
        role_type: input.roleType,
        name: input.name.trim(),
        shares_crew_schedule: input.sharesCrewSchedule,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to create worker role.");
    return {
      id: data.id,
      businessId: data.business_id,
      roleType: data.role_type,
      name: data.name,
      sharesCrewSchedule: data.shares_crew_schedule,
      active: data.active,
      createdAt: data.created_at,
    };
  }
  const state = loadSyntheticStore();
  const role: WorkerRole = {
    id: newId(),
    businessId: session.businessId,
    roleType: input.roleType,
    name: input.name.trim(),
    sharesCrewSchedule: input.sharesCrewSchedule,
    active: true,
    createdAt: new Date().toISOString(),
  };
  state.workerRoles.push(role);
  appendSyntheticAudit(state, session, "worker_role", role.id, "created", { name: role.name });
  saveSyntheticStore(state);
  return role;
}

export async function updateWorkerRole(
  session: AuthSession,
  roleId: string,
  input: { roleType: WorkerRoleType; name: string; sharesCrewSchedule: boolean },
): Promise<WorkerRole> {
  if (!can(session.role, "rates.edit")) {
    throw new Error("Access denied: only Management / Admin can edit worker roles.");
  }
  if (!input.name.trim()) throw new Error("Role name is required.");
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("worker_roles")
      .update({
        role_type: input.roleType,
        name: input.name.trim(),
        shares_crew_schedule: input.sharesCrewSchedule,
      })
      .eq("id", roleId)
      .eq("business_id", session.businessId)
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to update worker role.");
    return {
      id: data.id,
      businessId: data.business_id,
      roleType: data.role_type,
      name: data.name,
      sharesCrewSchedule: data.shares_crew_schedule,
      active: data.active,
      createdAt: data.created_at,
    };
  }
  const state = loadSyntheticStore();
  const role = state.workerRoles.find((r) => r.id === roleId);
  if (!role) throw new Error("Worker role not found.");
  assertBusinessBoundary(session, role.businessId, "worker role");
  role.name = input.name.trim();
  role.roleType = input.roleType;
  role.sharesCrewSchedule = input.sharesCrewSchedule;
  appendSyntheticAudit(state, session, "worker_role", role.id, "updated", {
    name: role.name,
    roleType: role.roleType,
    sharesCrewSchedule: role.sharesCrewSchedule,
  });
  saveSyntheticStore(state);
  return role;
}

export async function createPayRule(
  session: AuthSession,
  input: {
    workerRoleId: string;
    payBasis: PayBasis;
    baseRateCents: number;
    normalHoursPerDay: number;
    normalWorkdaysPerWeek: number;
    weekdayOtHourlyCents: number | null;
    saturdayRateCents: number | null;
    sundayRateCents: number | null;
    publicHolidayRateCents: number | null;
    weeklyProrationPolicy: "full_week_entitlement" | "prorated_by_days" | "none";
    effectiveFrom: string;
    effectiveTo: string | null;
    isConfirmed: boolean;
    notes: string;
  },
): Promise<PayRule> {
  if (!can(session.role, "rates.edit")) {
    throw new Error("Access denied: only Management / Admin can configure pay rules.");
  }
  const bundle = await listWorkforceBundle(session);
  const validationError = validatePayRuleCandidate(input, bundle.payRules);
  if (validationError) throw new Error(validationError);

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("pay_rules")
      .insert({
        business_id: session.businessId,
        worker_role_id: input.workerRoleId,
        pay_basis: input.payBasis,
        base_rate_cents: input.baseRateCents,
        normal_hours_per_day: input.normalHoursPerDay,
        normal_workdays_per_week: input.normalWorkdaysPerWeek,
        weekday_ot_hourly_cents: input.weekdayOtHourlyCents,
        saturday_rate_cents: input.saturdayRateCents,
        sunday_rate_cents: input.sundayRateCents,
        public_holiday_rate_cents: input.publicHolidayRateCents,
        weekly_proration_policy: input.weeklyProrationPolicy,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo,
        is_confirmed: input.isConfirmed,
        notes: input.notes.trim(),
        created_by: session.userId,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to create pay rule.");
    return {
      id: data.id,
      businessId: data.business_id,
      workerRoleId: data.worker_role_id,
      payBasis: data.pay_basis,
      baseRateCents: Number(data.base_rate_cents),
      normalHoursPerDay: Number(data.normal_hours_per_day),
      normalWorkdaysPerWeek: Number(data.normal_workdays_per_week),
      weekdayOtHourlyCents:
        data.weekday_ot_hourly_cents === null ? null : Number(data.weekday_ot_hourly_cents),
      saturdayRateCents:
        data.saturday_rate_cents === null ? null : Number(data.saturday_rate_cents),
      sundayRateCents: data.sunday_rate_cents === null ? null : Number(data.sunday_rate_cents),
      publicHolidayRateCents:
        data.public_holiday_rate_cents === null ? null : Number(data.public_holiday_rate_cents),
      weeklyProrationPolicy: data.weekly_proration_policy,
      effectiveFrom: data.effective_from,
      effectiveTo: data.effective_to,
      isConfirmed: data.is_confirmed,
      notes: data.notes ?? "",
      createdAt: data.created_at,
    };
  }

  const state = loadSyntheticStore();
  const rule: PayRule = {
    id: newId(),
    businessId: session.businessId,
    ...input,
    notes: input.notes.trim(),
    createdAt: new Date().toISOString(),
  };
  state.payRules.unshift(rule);
  appendSyntheticAudit(state, session, "pay_rule", rule.id, "created", {
    workerRoleId: rule.workerRoleId,
    baseRateCents: rule.baseRateCents,
    effectiveFrom: rule.effectiveFrom,
  });
  saveSyntheticStore(state);
  return rule;
}

export async function updatePayRule(
  session: AuthSession,
  payRuleId: string,
  input: {
    workerRoleId: string;
    payBasis: PayBasis;
    baseRateCents: number;
    normalHoursPerDay: number;
    normalWorkdaysPerWeek: number;
    weekdayOtHourlyCents: number | null;
    saturdayRateCents: number | null;
    sundayRateCents: number | null;
    publicHolidayRateCents: number | null;
    weeklyProrationPolicy: "full_week_entitlement" | "prorated_by_days" | "none";
    effectiveFrom: string;
    effectiveTo: string | null;
    isConfirmed: boolean;
    notes: string;
  },
): Promise<PayRule> {
  if (!can(session.role, "rates.edit")) {
    throw new Error("Access denied: only Management / Admin can edit pay rules.");
  }
  const bundle = await listWorkforceBundle(session);
  const validationError = validatePayRuleCandidate({ id: payRuleId, ...input }, bundle.payRules);
  if (validationError) throw new Error(validationError);

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("pay_rules")
      .update({
        pay_basis: input.payBasis,
        base_rate_cents: input.baseRateCents,
        normal_hours_per_day: input.normalHoursPerDay,
        normal_workdays_per_week: input.normalWorkdaysPerWeek,
        weekday_ot_hourly_cents: input.weekdayOtHourlyCents,
        saturday_rate_cents: input.saturdayRateCents,
        sunday_rate_cents: input.sundayRateCents,
        public_holiday_rate_cents: input.publicHolidayRateCents,
        weekly_proration_policy: input.weeklyProrationPolicy,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo,
        is_confirmed: input.isConfirmed,
        notes: input.notes.trim(),
      })
      .eq("id", payRuleId)
      .eq("business_id", session.businessId)
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to update pay rule.");
    return {
      id: data.id,
      businessId: data.business_id,
      workerRoleId: data.worker_role_id,
      payBasis: data.pay_basis,
      baseRateCents: Number(data.base_rate_cents),
      normalHoursPerDay: Number(data.normal_hours_per_day),
      normalWorkdaysPerWeek: Number(data.normal_workdays_per_week),
      weekdayOtHourlyCents:
        data.weekday_ot_hourly_cents === null ? null : Number(data.weekday_ot_hourly_cents),
      saturdayRateCents:
        data.saturday_rate_cents === null ? null : Number(data.saturday_rate_cents),
      sundayRateCents: data.sunday_rate_cents === null ? null : Number(data.sunday_rate_cents),
      publicHolidayRateCents:
        data.public_holiday_rate_cents === null ? null : Number(data.public_holiday_rate_cents),
      weeklyProrationPolicy: data.weekly_proration_policy,
      effectiveFrom: data.effective_from,
      effectiveTo: data.effective_to,
      isConfirmed: data.is_confirmed,
      notes: data.notes ?? "",
      createdAt: data.created_at,
    };
  }

  const state = loadSyntheticStore();
  const rule = state.payRules.find((r) => r.id === payRuleId);
  if (!rule) throw new Error("Pay rule not found.");
  assertBusinessBoundary(session, rule.businessId, "pay rule");
  Object.assign(rule, { ...input, notes: input.notes.trim() });
  appendSyntheticAudit(state, session, "pay_rule", rule.id, "updated", {
    workerRoleId: rule.workerRoleId,
    baseRateCents: rule.baseRateCents,
    weekdayOtHourlyCents: rule.weekdayOtHourlyCents,
    saturdayRateCents: rule.saturdayRateCents,
    sundayRateCents: rule.sundayRateCents,
    publicHolidayRateCents: rule.publicHolidayRateCents,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
  });
  saveSyntheticStore(state);
  return rule;
}

export async function closePayRule(
  session: AuthSession,
  payRuleId: string,
  effectiveTo: string,
): Promise<void> {
  if (!can(session.role, "rates.edit")) {
    throw new Error("Access denied: only Management / Admin can close pay rules.");
  }
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase
      .from("pay_rules")
      .update({ effective_to: effectiveTo })
      .eq("id", payRuleId)
      .eq("business_id", session.businessId);
    if (error) throw new Error(error.message);
    return;
  }
  const state = loadSyntheticStore();
  const rule = state.payRules.find((r) => r.id === payRuleId);
  if (!rule) throw new Error("Pay rule not found.");
  assertBusinessBoundary(session, rule.businessId, "pay rule");
  if (effectiveTo < rule.effectiveFrom) {
    throw new Error("End date cannot be earlier than start date.");
  }
  rule.effectiveTo = effectiveTo;
  appendSyntheticAudit(state, session, "pay_rule", rule.id, "closed", { effectiveTo });
  saveSyntheticStore(state);
}

export async function saveWorker(
  session: AuthSession,
  input: {
    id?: string;
    fullName: string;
    contactPhone: string | null;
    workerRoleId: string;
    employmentStartDate: string;
    employmentEndDate: string | null;
    active: boolean;
    openingBalanceCents: number;
    openingBalanceSource: string;
  },
): Promise<Worker> {
  const perm = input.id ? "workers.edit" : "workers.add";
  if (!can(session.role, perm)) {
    throw new Error("Access denied: you do not have permission to save this worker.");
  }
  if (!input.fullName.trim()) throw new Error("Worker full name is required.");
  if (!input.workerRoleId) throw new Error("Select a worker role.");
  if (!input.employmentStartDate) throw new Error("Employment start date is required.");

  if (isSupabaseConfigured && supabase) {
    const payload = {
      business_id: session.businessId,
      full_name: input.fullName.trim(),
      contact_phone: input.contactPhone?.trim() || null,
      worker_role_id: input.workerRoleId,
      employment_start_date: input.employmentStartDate,
      employment_end_date: input.employmentEndDate,
      active: input.active,
      opening_balance_cents: input.openingBalanceCents,
      opening_balance_source: input.openingBalanceSource.trim(),
    };
    const q = input.id
      ? supabase
          .from("workers")
          .update(payload)
          .eq("id", input.id)
          .eq("business_id", session.businessId)
          .select("*")
          .single()
      : supabase.from("workers").insert({ ...payload, created_by: session.userId }).select("*").single();
    const { data, error } = await q;
    if (error || !data) throw new Error(error?.message ?? "Failed to save worker.");
    return {
      id: data.id,
      businessId: data.business_id,
      fullName: data.full_name,
      contactPhone: data.contact_phone,
      workerRoleId: data.worker_role_id,
      employmentStartDate: data.employment_start_date,
      employmentEndDate: data.employment_end_date,
      active: data.active,
      openingBalanceCents: Number(data.opening_balance_cents),
      openingBalanceSource: data.opening_balance_source ?? "",
      openingBalanceVerified: data.opening_balance_verified,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  const state = loadSyntheticStore();
  const now = new Date().toISOString();
  if (input.id) {
    const idx = state.workers.findIndex((w) => w.id === input.id);
    if (idx < 0) throw new Error("Worker not found.");
    const existing = state.workers[idx]!;
    assertBusinessBoundary(session, existing.businessId, "worker");
    const updated: Worker = {
      ...existing,
      fullName: input.fullName.trim(),
      contactPhone: input.contactPhone?.trim() || null,
      workerRoleId: input.workerRoleId,
      employmentStartDate: input.employmentStartDate,
      employmentEndDate: input.employmentEndDate,
      active: input.active,
      openingBalanceCents: input.openingBalanceCents,
      openingBalanceSource: input.openingBalanceSource.trim(),
      updatedAt: now,
    };
    state.workers[idx] = updated;
    appendSyntheticAudit(state, session, "worker", updated.id, "updated", {
      active: updated.active,
    });
    saveSyntheticStore(state);
    return updated;
  }
  const created: Worker = {
    id: newId(),
    businessId: session.businessId,
    fullName: input.fullName.trim(),
    contactPhone: input.contactPhone?.trim() || null,
    workerRoleId: input.workerRoleId,
    employmentStartDate: input.employmentStartDate,
    employmentEndDate: input.employmentEndDate,
    active: input.active,
    openingBalanceCents: input.openingBalanceCents,
    openingBalanceSource: input.openingBalanceSource.trim(),
    openingBalanceVerified: false,
    createdAt: now,
    updatedAt: now,
  };
  state.workers.unshift(created);
  appendSyntheticAudit(state, session, "worker", created.id, "created", {
    fullName: created.fullName,
  });
  saveSyntheticStore(state);
  return created;
}

export async function requestRateOverride(
  session: AuthSession,
  input: {
    workerId: string;
    payBasis: PayBasis;
    proposedRateCents: number;
    effectiveFrom: string;
    reason: string;
  },
): Promise<WorkerRateOverride> {
  if (!can(session.role, "rates.request_override")) {
    throw new Error("Access denied: you cannot request rate changes.");
  }
  if (!Number.isInteger(input.proposedRateCents) || input.proposedRateCents <= 0) {
    throw new Error("Proposed rate must be a positive ZAR amount.");
  }
  if (!input.reason.trim()) throw new Error("Provide a reason for the rate change request.");

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("worker_rate_overrides")
      .insert({
        business_id: session.businessId,
        worker_id: input.workerId,
        pay_basis: input.payBasis,
        proposed_rate_cents: input.proposedRateCents,
        effective_from: input.effectiveFrom,
        reason: input.reason.trim(),
        status: "pending",
        requested_by: session.userId,
        requested_by_email: session.email,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to submit rate override.");
    return {
      id: data.id,
      businessId: data.business_id,
      workerId: data.worker_id,
      payBasis: data.pay_basis,
      proposedRateCents: Number(data.proposed_rate_cents),
      effectiveFrom: data.effective_from,
      effectiveTo: data.effective_to,
      reason: data.reason,
      status: data.status,
      requestedBy: data.requested_by_email ?? session.email,
      reviewedBy: data.reviewed_by_email ?? null,
      createdAt: data.created_at,
    };
  }
  const state = loadSyntheticStore();
  const created: WorkerRateOverride = {
    id: newId(),
    businessId: session.businessId,
    workerId: input.workerId,
    payBasis: input.payBasis,
    proposedRateCents: input.proposedRateCents,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: null,
    reason: input.reason.trim(),
    status: "pending",
    requestedBy: session.email,
    reviewedBy: null,
    createdAt: new Date().toISOString(),
  };
  state.rateOverrides.unshift(created);
  appendSyntheticAudit(state, session, "worker_rate_override", created.id, "requested", {
    proposedRateCents: created.proposedRateCents,
  });
  saveSyntheticStore(state);
  return created;
}

export async function reviewRateOverride(
  session: AuthSession,
  overrideId: string,
  decision: "approved" | "declined",
): Promise<void> {
  if (!can(session.role, "rates.approve_override")) {
    throw new Error("Access denied: only Management / Admin can approve or decline rate overrides.");
  }
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase
      .from("worker_rate_overrides")
      .update({
        status: decision,
        reviewed_by: session.userId,
        reviewed_by_email: session.email,
      })
      .eq("id", overrideId)
      .eq("business_id", session.businessId);
    if (error) throw new Error(error.message);
    return;
  }
  const state = loadSyntheticStore();
  const item = state.rateOverrides.find((o) => o.id === overrideId);
  if (!item) throw new Error("Rate override request not found.");
  assertBusinessBoundary(session, item.businessId, "rate override");
  item.status = decision;
  item.reviewedBy = session.email;
  appendSyntheticAudit(state, session, "worker_rate_override", item.id, decision, {
    status: decision,
  });
  saveSyntheticStore(state);
}

export async function createWorkerAssignment(
  session: AuthSession,
  input: { workerId: string; jobId: string; assignedFrom: string },
): Promise<WorkerAssignment> {
  if (!can(session.role, "workers.add")) {
    throw new Error("Access denied: you cannot assign workers to jobs.");
  }
  if (!input.workerId || !input.jobId) throw new Error("Select both a worker and a job.");
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("worker_assignments")
      .insert({
        business_id: session.businessId,
        worker_id: input.workerId,
        job_id: input.jobId,
        assigned_from: input.assignedFrom,
        active: true,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to create assignment.");
    return {
      id: data.id,
      businessId: data.business_id,
      workerId: data.worker_id,
      jobId: data.job_id,
      assignedFrom: data.assigned_from,
      assignedTo: data.assigned_to,
      active: data.active,
    };
  }
  const state = loadSyntheticStore();
  const created: WorkerAssignment = {
    id: newId(),
    businessId: session.businessId,
    workerId: input.workerId,
    jobId: input.jobId,
    assignedFrom: input.assignedFrom,
    assignedTo: null,
    active: true,
  };
  state.assignments.unshift(created);
  appendSyntheticAudit(state, session, "worker_assignment", created.id, "created", {
    workerId: created.workerId,
    jobId: created.jobId,
  });
  saveSyntheticStore(state);
  return created;
}

export async function listAuditEvents(session: AuthSession): Promise<AuditEvent[]> {
  if (!can(session.role, "audit.view")) return [];
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("audit_events")
      .select("*")
      .eq("business_id", session.businessId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) return [];
    return (data ?? []).map((e) => ({
      id: e.id,
      businessId: e.business_id,
      actorUserId: e.actor_user_id,
      actorEmail: e.actor_email ?? "",
      entityType: e.entity_type,
      entityId: e.entity_id,
      action: e.action,
      reason: e.reason,
      changedFields: (e.changed_fields ?? {}) as Record<string, unknown>,
      createdAt: e.created_at,
    }));
  }
  const state = loadSyntheticStore();
  return state.auditEvents.filter((e) => e.businessId === session.businessId).slice(0, 25);
}