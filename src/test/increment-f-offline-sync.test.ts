import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AuthSession } from "@/lib/domain/types";
import {
  listFinanceBundle,
  recordExpense,
  updateExpenseWithRevision,
} from "@/lib/data/increment-d-repository";
import { listIncrementEBundle } from "@/lib/data/increment-e-repository";
import { SYNTHETIC_BIZ_A, SYNTHETIC_JOB_1 } from "@/lib/data/synthetic-fixtures";
import {
  listAttachments,
  listConflicts,
  listMutations,
  putMutation,
  resetInMemoryOfflineStore,
} from "@/lib/offline/idb-store";
import {
  clearUserOfflineDataOnLogout,
  computeBackoffMs,
  enqueueOfflineMutation,
  resolveConflictRecord,
  runSyncEngine,
  saveOfflineAttachment,
  sortMutationsByDependency,
} from "@/lib/offline/sync-engine";
import { isSwRegistrationRefused } from "@/lib/offline/pwa-register";

const ADMIN_SESSION: AuthSession = {
  userId: "user-admin-1",
  email: "admin@karooverge.example",
  fullName: "Nomsa Dlamini",
  businessId: SYNTHETIC_BIZ_A,
  businessName: "Karoo Verge Clearing (Synthetic)",
  role: "admin",
  assignedJobIds: [SYNTHETIC_JOB_1],
  mode: "synthetic_dev",
};

const OWNER_SESSION: AuthSession = {
  userId: "user-owner-1",
  email: "owner@karooverge.example",
  fullName: "Sipho Khumalo",
  businessId: SYNTHETIC_BIZ_A,
  businessName: "Karoo Verge Clearing (Synthetic)",
  role: "owner",
  assignedJobIds: [SYNTHETIC_JOB_1],
  mode: "synthetic_dev",
};

describe("Increment F — Offline Sync Engine, Conflicts, Partitioning & Security", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.clear();
    }
    resetInMemoryOfflineStore();
  });

  it("T19: replaying an offline expense twice creates exactly one expense and one balanced ledger posting", async () => {
    const before = await listFinanceBundle(OWNER_SESSION);
    const initialExpenseCount = before.expenses.length;
    const initialJournalCount = before.journalEntries.length;
    const cashAccount = before.accounts.find((a) => a.isCashAccount && !a.isRestricted);
    expect(cashAccount).toBeDefined();

    const idempotencyKey = "offline-exp-replay-t19";
    const payload = {
      jobId: SYNTHETIC_JOB_1,
      expenseDate: "2026-11-27",
      category: "fuel",
      classification: "operating",
      amountCents: 145000,
      paidAmountCents: 145000,
      paymentStatus: "paid",
      accountId: cashAccount!.id,
      method: "cash",
      supplierName: "Engen N2",
      description: "Diesel for brush cutters",
      reference: "INV-T19-001",
      fuelLitres: 60,
      vehicleOrMachine: "Isuzu Truck",
      odometerKm: 124500,
      receiptAttachment: null,
      missingReceiptReason: "Slip faded — photo captured separately",
    };

    const m1 = await enqueueOfflineMutation(OWNER_SESSION, {
      entityType: "expense",
      operation: "create",
      label: "Expense: fuel (R 1 450.00)",
      payload,
      idempotencyKey,
    });

    // Offline sync attempt does not drop queued mutation
    const offlineSummary = await runSyncEngine(OWNER_SESSION, { isOnline: false });
    expect(offlineSummary.skippedOffline).toBe(true);
    expect(offlineSummary.synced).toBe(0);

    // First online sync succeeds
    const firstSync = await runSyncEngine(OWNER_SESSION, { isOnline: true });
    expect(firstSync.synced).toBe(1);

    // Simulate network drop before ack by resetting mutation to queued and replaying same idempotencyKey
    await putMutation({ ...m1, status: "queued", syncedAt: null });
    const secondSync = await runSyncEngine(OWNER_SESSION, { isOnline: true, forceRetry: true });
    expect(secondSync.synced).toBe(1);

    const after = await listFinanceBundle(OWNER_SESSION);
    expect(after.expenses.length).toBe(initialExpenseCount + 1);
    expect(after.journalEntries.length).toBe(initialJournalCount + 1);
    const created = after.expenses.find((e) => e.idempotencyKey === idempotencyKey);
    expect(created).toBeDefined();
    expect(created!.amountCents).toBe(145000);
  });

  it("T20: concurrent edit with stale revision flags conflict without silent overwrite and resolves cleanly", async () => {
    const bundle = await listFinanceBundle(ADMIN_SESSION);
    const cashAccount = bundle.accounts.find((a) => a.isCashAccount && !a.isRestricted)!;
    const expense = await recordExpense(ADMIN_SESSION, {
      jobId: SYNTHETIC_JOB_1,
      expenseDate: "2026-11-27",
      category: "supplies",
      classification: "operating",
      amountCents: 35000,
      paidAmountCents: 35000,
      paymentStatus: "paid",
      accountId: cashAccount.id,
      method: "cash",
      supplierName: "BuildIt",
      description: "Initial trimmer line",
      reference: "INV-T20",
      fuelLitres: null,
      vehicleOrMachine: "",
      odometerKm: null,
      receiptAttachment: null,
      missingReceiptReason: "Cash slip pending",
    });
    expect(expense.revision).toBe(1);

    // Server advances to revision 2 (Admin edits online)
    const adminUpdate = await updateExpenseWithRevision(ADMIN_SESSION, expense.id, 1, {
      description: "Admin updated trimmer line (rev 2)",
    });
    expect(adminUpdate.status).toBe("updated");
    expect(adminUpdate.serverRevision).toBe(2);

    // Owner queued an offline edit based on stale revision 1
    await enqueueOfflineMutation(OWNER_SESSION, {
      entityType: "expense",
      operation: "update",
      entityId: expense.id,
      baseRevision: 1,
      label: "Expense INV-T20",
      payload: {
        description: "Owner offline edit (from rev 1)",
        supplierName: "BuildIt George",
      },
    });

    const summary = await runSyncEngine(OWNER_SESSION, { isOnline: true });
    expect(summary.conflicts).toBe(1);
    expect(summary.synced).toBe(0);

    // Server record must NOT have been silently overwritten
    const afterConflict = await listFinanceBundle(ADMIN_SESSION);
    const unchanged = afterConflict.expenses.find((e) => e.id === expense.id)!;
    expect(unchanged.description).toBe("Admin updated trimmer line (rev 2)");
    expect(unchanged.revision).toBe(2);

    // Conflict record holds both versions
    const conflicts = await listConflicts(OWNER_SESSION.businessId, OWNER_SESSION.userId);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.baseRevision).toBe(1);
    expect(conflicts[0]!.serverRevision).toBe(2);
    expect(conflicts[0]!.localPayload["description"]).toBe("Owner offline edit (from rev 1)");
    expect(conflicts[0]!.serverPayload["description"]).toBe("Admin updated trimmer line (rev 2)");

    // Explicitly resolve by applying local changes as revision 3
    await resolveConflictRecord(OWNER_SESSION, conflicts[0]!.id, "apply_local_as_new_revision");
    const finalBundle = await listFinanceBundle(ADMIN_SESSION);
    const resolved = finalBundle.expenses.find((e) => e.id === expense.id)!;
    expect(resolved.description).toBe("Owner offline edit (from rev 1)");
    expect(resolved.revision).toBe(3);
    expect(await listConflicts(OWNER_SESSION.businessId, OWNER_SESSION.userId)).toHaveLength(0);
  });

  it("T22 (offline): critical truck oil issue syncs once on reconnect, marks asset unavailable, and raises alert", async () => {
    const before = await listIncrementEBundle(OWNER_SESSION);
    const truck = before.assets.find((a) => a.assetType === "truck") ?? before.assets[0]!;
    const initialDefects = before.defects.length;

    await enqueueOfflineMutation(OWNER_SESSION, {
      entityType: "vehicle_check",
      operation: "create",
      label: `Truck check: ${truck.name} (STOP DO NOT USE)`,
      idempotencyKey: "offline-truck-oil-t22",
      payload: {
        assetId: truck.id,
        jobId: SYNTHETIC_JOB_1,
        checkDate: "2026-11-27",
        odometerKm: 130000,
        items: {
          oil: "problem",
          coolant: "ok",
          leaks: "ok",
          tyres: "ok",
          brakes_lights: "ok",
          warning_lights: "ok",
        },
        comment: "Oil dipstick dry — do not start engine",
        photoNote: null,
        isOffline: true,
      },
    });

    const syncRes = await runSyncEngine(OWNER_SESSION, { isOnline: true });
    expect(syncRes.synced).toBe(1);

    const after = await listIncrementEBundle(OWNER_SESSION);
    const updatedTruck = after.assets.find((a) => a.id === truck.id)!;
    expect(updatedTruck.status).toBe("unavailable_defect");
    expect(after.defects.length).toBe(initialDefects + 1);
    expect(after.notifications.some((n) => n.type === "vehicle_stop_use")).toBe(true);
  });

  it("T26: enforces parent-before-attachment dependency order, user partitioning, and logout wipe", async () => {
    const bundle = await listFinanceBundle(OWNER_SESSION);
    const cashAccount = bundle.accounts.find((a) => a.isCashAccount && !a.isRestricted)!;

    const parentMut = await enqueueOfflineMutation(OWNER_SESSION, {
      entityType: "expense",
      operation: "create",
      label: "Expense with receipt photo",
      payload: {
        jobId: SYNTHETIC_JOB_1,
        expenseDate: "2026-11-27",
        category: "supplies",
        classification: "operating",
        amountCents: 12000,
        paidAmountCents: 12000,
        paymentStatus: "paid",
        accountId: cashAccount.id,
        method: "cash",
        supplierName: "Co-op",
        description: "Gloves",
        reference: "INV-T26",
        fuelLitres: null,
        vehicleOrMachine: "",
        odometerKm: null,
        receiptAttachment: null,
        missingReceiptReason: "Photo queued offline",
      },
    });

    const { attachment, mutation: attMut } = await saveOfflineAttachment(OWNER_SESSION, {
      linkedEntityType: "expense",
      linkedEntityId: "pending-parent",
      linkedLabel: "Gloves slip",
      fileName: "slip.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      sha256Checksum: "a".repeat(64),
      dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      exifStripped: true,
      locationConsented: false,
      latitude: null,
      longitude: null,
      dependsOnMutationId: parentMut.id,
    });

    // Dependency sort must always put parent before attachment even when passed in reverse order
    const sorted = sortMutationsByDependency([attMut, parentMut]);
    expect(sorted[0]!.id).toBe(parentMut.id);
    expect(sorted[1]!.id).toBe(attMut.id);

    // Partition isolation: Admin cannot see Owner's queued drafts or attachments
    expect(await listMutations(ADMIN_SESSION.businessId, ADMIN_SESSION.userId)).toHaveLength(0);
    expect(await listAttachments(ADMIN_SESSION.businessId, ADMIN_SESSION.userId)).toHaveLength(0);

    // Sync runs parent then attachment and updates attachment linkedEntityId to created expense ID
    const syncRes = await runSyncEngine(OWNER_SESSION, { isOnline: true });
    expect(syncRes.synced).toBe(2);
    const syncedAttachments = await listAttachments(OWNER_SESSION.businessId, OWNER_SESSION.userId);
    const syncedAtt = syncedAttachments.find((a) => a.id === attachment.id)!;
    expect(syncedAtt.uploadStatus).toBe("uploaded");
    expect(syncedAtt.linkedEntityId).not.toBe("pending-parent");

    // Logout clears protected local data for Owner
    await clearUserOfflineDataOnLogout(OWNER_SESSION);
    expect(await listMutations(OWNER_SESSION.businessId, OWNER_SESSION.userId)).toHaveLength(0);
    expect(await listAttachments(OWNER_SESSION.businessId, OWNER_SESSION.userId)).toHaveLength(0);
  });

  it("PWA guard refuses dev, iframe, Lovable preview hosts, and ?sw=off while allowing published VM domains", () => {
    expect(isSwRegistrationRefused({ isProd: false, hostname: "worktrack.example.co.za" }).refused).toBe(true);
    expect(isSwRegistrationRefused({ isProd: true, inIframe: true, hostname: "worktrack.example.co.za" }).refused).toBe(true);
    expect(isSwRegistrationRefused({ isProd: true, inIframe: false, hostname: "id-preview--abc123.lovable.app" }).refused).toBe(true);
    expect(isSwRegistrationRefused({ isProd: true, inIframe: false, hostname: "preview--abc123.lovable.app" }).refused).toBe(true);
    expect(isSwRegistrationRefused({ isProd: true, inIframe: false, hostname: "app.lovableproject.com" }).refused).toBe(true);
    expect(isSwRegistrationRefused({ isProd: true, inIframe: false, hostname: "worktrack.example.co.za", search: "?sw=off" }).refused).toBe(true);
    expect(isSwRegistrationRefused({ isProd: true, inIframe: false, hostname: "worktrack.example.co.za", search: "" }).refused).toBe(false);
    expect(computeBackoffMs(1)).toBe(1000);
    expect(computeBackoffMs(3)).toBe(4000);
  });

  it("T27/T28: Increment F migration enforces RLS, revokes anon, and keeps evidence bucket private", () => {
    const sqlPath = path.resolve(
      process.cwd(),
      "db/migrations/202611270007_increment_f_offline_sync_storage.sql",
    );
    const sql = fs.readFileSync(sqlPath, "utf8");
    expect(sql).toContain("ALTER TABLE public.sync_idempotency_keys ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.evidence_attachments ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON public.sync_idempotency_keys FROM anon");
    expect(sql).toContain("REVOKE ALL ON public.evidence_attachments FROM anon");
    expect(sql).toContain("SET public = false");
  });
});