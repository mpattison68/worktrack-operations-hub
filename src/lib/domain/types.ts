export type AppRole = "admin" | "owner" | "supervisor";

export type JobStatus =
  | "assessment_draft"
  | "submitted"
  | "returned"
  | "approved"
  | "planned"
  | "active"
  | "work_complete"
  | "customer_accepted"
  | "financially_closed"
  | "on_hold"
  | "cancelled";

export type VatBasis = "exclusive" | "inclusive" | "exempt" | "not_registered";

export type WorkerRoleType =
  | "road_worker"
  | "supervisor"
  | "driver"
  | "cook"
  | "admin"
  | "owner"
  | "other";

export type PayBasis = "daily" | "hourly" | "weekly";

export type RateChangeStatus = "pending" | "approved" | "declined";

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Business {
  id: string;
  name: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  defaultVatBasis: VatBasis;
  timezone: string;
  currency: string;
  weekStartDay: 1; // Monday
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  id: string;
  businessId: string;
  userId: string;
  email: string;
  fullName: string;
  role: AppRole;
  active: boolean;
  assignedJobIds: string[];
  createdAt: string;
}

export interface Invitation {
  id: string;
  businessId: string;
  email: string;
  fullName: string;
  role: AppRole;
  assignedJobIds: string[];
  status: InvitationStatus;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface Job {
  id: string;
  businessId: string;
  name: string;
  customerName: string;
  contractReference: string;
  contractValueCents: number;
  vatBasis: VatBasis;
  roadOrArea: string;
  status: JobStatus;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  openingCashAllocationCents: number;
  workRequirements: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerRole {
  id: string;
  businessId: string;
  roleType: WorkerRoleType;
  name: string;
  sharesCrewSchedule: boolean;
  active: boolean;
  createdAt: string;
}

export interface PayRule {
  id: string;
  businessId: string;
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
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD or null for open-ended
  isConfirmed: boolean;
  notes: string;
  createdAt: string;
}

export interface Worker {
  id: string;
  businessId: string;
  fullName: string;
  contactPhone: string | null;
  workerRoleId: string;
  employmentStartDate: string;
  employmentEndDate: string | null;
  active: boolean;
  openingBalanceCents: number; // positive = arrears owed to worker, negative = advance
  openingBalanceSource: string;
  openingBalanceVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerRateOverride {
  id: string;
  businessId: string;
  workerId: string;
  payBasis: PayBasis;
  proposedRateCents: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  status: RateChangeStatus;
  requestedBy: string;
  reviewedBy: string | null;
  createdAt: string;
}

export interface WorkerAssignment {
  id: string;
  businessId: string;
  workerId: string;
  jobId: string;
  assignedFrom: string;
  assignedTo: string | null;
  active: boolean;
}

export interface AuditEvent {
  id: string;
  businessId: string;
  actorUserId: string;
  actorEmail: string;
  entityType: string;
  entityId: string;
  action: string;
  reason: string | null;
  changedFields: Record<string, unknown>;
  createdAt: string;
}

export interface AuthSession {
  userId: string;
  email: string;
  fullName: string;
  businessId: string;
  businessName: string;
  role: AppRole;
  assignedJobIds: string[];
  mode: "supabase" | "synthetic_dev";
}