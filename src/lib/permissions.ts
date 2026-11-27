import type { AppRole, AuthSession } from "@/lib/domain/types";

/**
 * Role permission matrix derived directly from docs/specification.md Section 2.
 * Enforced in UI, repository layer, and PostgreSQL RLS policies.
 */
export type PermissionAction =
  | "business.view"
  | "business.edit"
  | "users.manage"
  | "rates.view"
  | "rates.edit"
  | "rates.request_override"
  | "rates.approve_override"
  | "jobs.view_all"
  | "jobs.view_assigned"
  | "jobs.manage"
  | "scope.approve"
  | "workers.view_all"
  | "workers.view_assigned"
  | "workers.add"
  | "workers.edit"
  | "payroll.view"
  | "payroll.record_payment"
  | "payroll.reconcile"
  | "loans.view"
  | "loans.edit"
  | "audit.view";

const ROLE_PERMISSIONS: Record<AppRole, ReadonlySet<PermissionAction>> = {
  admin: new Set<PermissionAction>([
    "business.view",
    "business.edit",
    "users.manage",
    "rates.view",
    "rates.edit",
    "rates.request_override",
    "rates.approve_override",
    "jobs.view_all",
    "jobs.view_assigned",
    "jobs.manage",
    "scope.approve",
    "workers.view_all",
    "workers.view_assigned",
    "workers.add",
    "workers.edit",
    "payroll.view",
    "payroll.record_payment",
    "payroll.reconcile",
    "loans.view",
    "loans.edit",
    "audit.view",
  ]),
  owner: new Set<PermissionAction>([
    "business.view",
    "rates.view",
    "rates.request_override",
    "jobs.view_all",
    "jobs.view_assigned",
    "workers.view_all",
    "workers.view_assigned",
    "workers.add",
    "payroll.view",
    "payroll.record_payment",
    "loans.view",
  ]),
  supervisor: new Set<PermissionAction>([
    "jobs.view_assigned",
    "workers.view_assigned",
  ]),
};

export function can(role: AppRole | null | undefined, action: PermissionAction): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].has(action);
}

export function assertBusinessBoundary(
  session: AuthSession,
  recordBusinessId: string,
  resourceLabel = "record",
): void {
  if (session.businessId !== recordBusinessId) {
    throw new Error(`Access denied: ${resourceLabel} belongs to another business.`);
  }
}

export function canAccessJob(session: AuthSession, jobId: string, jobBusinessId: string): boolean {
  if (session.businessId !== jobBusinessId) return false;
  if (can(session.role, "jobs.view_all")) return true;
  return session.assignedJobIds.includes(jobId);
}