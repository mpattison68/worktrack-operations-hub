import { describe, expect, it } from "vitest";
import { assertBusinessBoundary, can, canAccessJob } from "@/lib/permissions";
import {
  SYNTHETIC_BIZ_A,
  SYNTHETIC_BIZ_B,
  SYNTHETIC_JOB_1,
  SYNTHETIC_JOB_2,
  SYNTHETIC_JOB_OTHER_BIZ,
} from "@/lib/data/synthetic-fixtures";
import type { AuthSession } from "@/lib/domain/types";

const adminSession: AuthSession = {
  userId: "u-admin-a",
  email: "admin@synthetic.worktrack.local",
  fullName: "Admin A",
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

const supervisorSession: AuthSession = {
  ...adminSession,
  userId: "u-sup-a",
  email: "supervisor@synthetic.worktrack.local",
  role: "supervisor",
  assignedJobIds: [SYNTHETIC_JOB_1],
};

describe("Increment A RBAC & tenant isolation (T21 foundation)", () => {
  it("denies supervisor access to business settings, pay rates, payroll, and loans", () => {
    expect(can("supervisor", "business.view")).toBe(false);
    expect(can("supervisor", "business.edit")).toBe(false);
    expect(can("supervisor", "rates.view")).toBe(false);
    expect(can("supervisor", "payroll.view")).toBe(false);
    expect(can("supervisor", "loans.view")).toBe(false);
  });

  it("allows owner to view rates, add workers, and request rate overrides, but not approve or edit jobs", () => {
    expect(can("owner", "rates.view")).toBe(true);
    expect(can("owner", "workers.add")).toBe(true);
    expect(can("owner", "rates.request_override")).toBe(true);
    expect(can("owner", "rates.approve_override")).toBe(false);
    expect(can("owner", "jobs.manage")).toBe(false);
    expect(can("owner", "business.edit")).toBe(false);
  });

  it("allows admin to manage business, users, jobs, rates, and approve overrides", () => {
    expect(can("admin", "business.edit")).toBe(true);
    expect(can("admin", "users.manage")).toBe(true);
    expect(can("admin", "jobs.manage")).toBe(true);
    expect(can("admin", "rates.edit")).toBe(true);
    expect(can("admin", "rates.approve_override")).toBe(true);
  });

  it("restricts supervisor to assigned jobs and rejects cross-business access", () => {
    expect(canAccessJob(supervisorSession, SYNTHETIC_JOB_1, SYNTHETIC_BIZ_A)).toBe(true);
    expect(canAccessJob(supervisorSession, SYNTHETIC_JOB_2, SYNTHETIC_BIZ_A)).toBe(false);
    expect(canAccessJob(adminSession, SYNTHETIC_JOB_OTHER_BIZ, SYNTHETIC_BIZ_B)).toBe(false);
    expect(canAccessJob(ownerSession, SYNTHETIC_JOB_OTHER_BIZ, SYNTHETIC_BIZ_B)).toBe(false);
    expect(() => assertBusinessBoundary(adminSession, SYNTHETIC_BIZ_B, "job")).toThrow(
      /another business/i,
    );
  });
});