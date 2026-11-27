import type { AuthSession } from "@/lib/domain/types";
import type {
  ExpenseCategory,
  ExpenseClassification,
  ExpensePaymentStatus,
  PaymentMethod,
  ReceiptAttachmentMeta,
} from "@/lib/domain/increment-d-types";
import type { CheckItemResult, PreUseCheckItemKey } from "@/lib/domain/increment-e-types";
import {
  recordExpense,
  updateExpenseWithRevision,
} from "@/lib/data/increment-d-repository";
import { recordPreUseCheck } from "@/lib/data/increment-e-repository";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import {
  clearPartition,
  deleteConflict,
  listAttachments,
  listConflicts,
  listMutations,
  makePartitionKey,
  putAttachment,
  putConflict,
  putMutation,
  setLastSyncAt,
} from "@/lib/offline/idb-store";
import { dataUrlToBytes } from "@/lib/offline/attachment-utils";
import type {
  ConflictRecord,
  OfflineAttachment,
  OfflineMutation,
  SyncEntityType,
  SyncRunSummary,
} from "@/lib/offline/types";

const DEFAULT_MAX_ATTEMPTS = 5;

export function computeBackoffMs(attempts: number): number {
  const clamped = Math.max(1, Math.min(attempts, 8));
  return Math.min(60_000, 1_000 * 2 ** (clamped - 1));
}

export interface EnqueueMutationInput<TPayload = Record<string, unknown>> {
  entityType: SyncEntityType;
  operation: "create" | "update" | "upload_attachment";
  entityId?: string | null;
  label: string;
  payload: TPayload;
  baseRevision?: number | null;
  dependsOnMutationId?: string | null;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export async function enqueueOfflineMutation<TPayload = Record<string, unknown>>(
  session: AuthSession,
  input: EnqueueMutationInput<TPayload>,
): Promise<OfflineMutation<TPayload>> {
  const existing = await listMutations(session.businessId, session.userId);
  if (input.idempotencyKey) {
    const found = existing.find((m) => m.idempotencyKey === input.idempotencyKey);
    if (found) {
      return found as OfflineMutation<TPayload>;
    }
  }

  const now = new Date().toISOString();
  const clientUuid = crypto.randomUUID();
  const mutation: OfflineMutation<TPayload> = {
    id: `mut-${clientUuid.slice(0, 12)}`,
    clientUuid,
    idempotencyKey: input.idempotencyKey ?? `${input.entityType}:${input.operation}:${clientUuid}`,
    businessId: session.businessId,
    userId: session.userId,
    partitionKey: makePartitionKey(session.businessId, session.userId),
    entityType: input.entityType,
    operation: input.operation,
    entityId: input.entityId ?? null,
    label: input.label,
    payload: input.payload,
    baseRevision: input.baseRevision ?? null,
    dependsOnMutationId: input.dependsOnMutationId ?? null,
    status: "queued",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    nextRetryAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
  };
  await putMutation(mutation as OfflineMutation);
  return mutation;
}

export async function saveOfflineAttachment(
  session: AuthSession,
  input: {
    linkedEntityType: OfflineAttachment["linkedEntityType"];
    linkedEntityId: string;
    linkedLabel: string;
    fileName: string;
    mimeType: OfflineAttachment["mimeType"];
    sizeBytes: number;
    sha256Checksum: string;
    dataUrl: string;
    exifStripped: boolean;
    locationConsented: boolean;
    latitude: number | null;
    longitude: number | null;
    dependsOnMutationId?: string | null;
  },
): Promise<{ attachment: OfflineAttachment; mutation: OfflineMutation }> {
  const now = new Date().toISOString();
  const id = `att-${crypto.randomUUID().slice(0, 12)}`;
  const attachment: OfflineAttachment = {
    id,
    businessId: session.businessId,
    userId: session.userId,
    partitionKey: makePartitionKey(session.businessId, session.userId),
    linkedEntityType: input.linkedEntityType,
    linkedEntityId: input.linkedEntityId,
    linkedLabel: input.linkedLabel,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256Checksum: input.sha256Checksum,
    dataUrl: input.dataUrl,
    exifStripped: input.exifStripped,
    locationConsented: input.locationConsented,
    latitude: input.locationConsented ? input.latitude : null,
    longitude: input.locationConsented ? input.longitude : null,
    uploadStatus: "saved_on_phone",
    storagePath: null,
    capturedAt: now,
    uploadedAt: null,
    lastError: null,
  };
  await putAttachment(attachment);

  const mutation = await enqueueOfflineMutation(session, {
    entityType: "attachment",
    operation: "upload_attachment",
    entityId: id,
    label: `Upload ${input.fileName} (${input.linkedLabel})`,
    payload: { attachmentId: id },
    dependsOnMutationId: input.dependsOnMutationId ?? null,
    idempotencyKey: `attachment:${id}`,
  });

  return { attachment, mutation };
}

export async function countUnsyncedItems(session: AuthSession): Promise<{
  pendingMutations: number;
  openConflicts: number;
  pendingAttachments: number;
  totalUnsynced: number;
}> {
  const [mutations, conflicts, attachments] = await Promise.all([
    listMutations(session.businessId, session.userId),
    listConflicts(session.businessId, session.userId),
    listAttachments(session.businessId, session.userId),
  ]);
  const pendingMutations = mutations.filter(
    (m) => m.status === "queued" || m.status === "syncing" || m.status === "failed",
  ).length;
  const openConflicts = conflicts.filter((c) => c.resolvedAt === null).length;
  const pendingAttachments = attachments.filter((a) => a.uploadStatus !== "uploaded").length;
  return {
    pendingMutations,
    openConflicts,
    pendingAttachments,
    totalUnsynced: pendingMutations + openConflicts,
  };
}

/**
 * Orders mutations so parent records always sync before dependent attachments/children.
 */
export function sortMutationsByDependency(mutations: OfflineMutation[]): OfflineMutation[] {
  const byId = new Map(mutations.map((m) => [m.id, m]));
  const visited = new Set<string>();
  const ordered: OfflineMutation[] = [];

  function visit(m: OfflineMutation) {
    if (visited.has(m.id)) return;
    visited.add(m.id);
    if (m.dependsOnMutationId) {
      const dep = byId.get(m.dependsOnMutationId);
      if (dep) visit(dep);
    }
    ordered.push(m);
  }

  for (const m of mutations) {
    visit(m);
  }
  return ordered;
}

async function executeMutation(
  session: AuthSession,
  mutation: OfflineMutation,
  resolvedParentIds: Map<string, string>,
): Promise<{ status: "synced" | "conflict"; createdEntityId?: string; conflict?: ConflictRecord }> {
  const payload = mutation.payload as Record<string, unknown>;

  if (mutation.entityType === "expense" && mutation.operation === "create") {
    const created = await recordExpense(session, {
      jobId: (payload["jobId"] as string | null) ?? null,
      expenseDate: String(payload["expenseDate"] ?? ""),
      category: payload["category"] as ExpenseCategory,
      classification: (payload["classification"] as ExpenseClassification) ?? "operating",
      amountCents: Number(payload["amountCents"] ?? 0),
      paidAmountCents: Number(payload["paidAmountCents"] ?? 0),
      paymentStatus: (payload["paymentStatus"] as ExpensePaymentStatus) ?? "paid",
      accountId: (payload["accountId"] as string | null) ?? null,
      method: (payload["method"] as PaymentMethod) ?? "cash",
      supplierName: String(payload["supplierName"] ?? ""),
      description: String(payload["description"] ?? ""),
      reference: String(payload["reference"] ?? ""),
      fuelLitres: (payload["fuelLitres"] as number | null) ?? null,
      vehicleOrMachine: String(payload["vehicleOrMachine"] ?? ""),
      odometerKm: (payload["odometerKm"] as number | null) ?? null,
      receiptAttachment: (payload["receiptAttachment"] as ReceiptAttachmentMeta | null) ?? null,
      missingReceiptReason: (payload["missingReceiptReason"] as string | null) ?? null,
      expenseRequestId: (payload["expenseRequestId"] as string | null) ?? null,
      unapprovedExceptionFlag: Boolean(payload["unapprovedExceptionFlag"]),
      idempotencyKey: mutation.idempotencyKey,
    });
    return { status: "synced", createdEntityId: created.id };
  }

  if (mutation.entityType === "expense" && mutation.operation === "update") {
    if (!mutation.entityId) {
      throw new Error("Missing expense ID for offline update.");
    }
    const result = await updateExpenseWithRevision(
      session,
      mutation.entityId,
      mutation.baseRevision ?? 1,
      {
        ...(payload["description"] !== undefined
          ? { description: String(payload["description"]) }
          : {}),
        ...(payload["supplierName"] !== undefined
          ? { supplierName: String(payload["supplierName"]) }
          : {}),
        ...(payload["reference"] !== undefined ? { reference: String(payload["reference"]) } : {}),
        ...(payload["missingReceiptReason"] !== undefined
          ? { missingReceiptReason: payload["missingReceiptReason"] as string | null }
          : {}),
      },
    );
    if (result.status === "conflict") {
      const conflict: ConflictRecord = {
        id: `conf-${crypto.randomUUID().slice(0, 12)}`,
        mutationId: mutation.id,
        businessId: session.businessId,
        userId: session.userId,
        partitionKey: mutation.partitionKey,
        entityType: "expense",
        entityId: mutation.entityId,
        entityLabel: mutation.label,
        baseRevision: mutation.baseRevision ?? 1,
        serverRevision: result.serverRevision,
        localPayload: payload,
        serverPayload: {
          description: result.expense.description,
          supplierName: result.expense.supplierName,
          reference: result.expense.reference,
          missingReceiptReason: result.expense.missingReceiptReason,
          amountCents: result.expense.amountCents,
        },
        detectedAt: new Date().toISOString(),
        resolvedAt: null,
        resolution: null,
      };
      return { status: "conflict", conflict };
    }
    return { status: "synced", createdEntityId: result.expense.id };
  }

  if (mutation.entityType === "vehicle_check" && mutation.operation === "create") {
    const res = await recordPreUseCheck(session, {
      assetId: String(payload["assetId"] ?? ""),
      jobId: (payload["jobId"] as string | null) ?? null,
      checkDate: String(payload["checkDate"] ?? ""),
      odometerKm: (payload["odometerKm"] as number | null) ?? null,
      items: payload["items"] as Record<PreUseCheckItemKey, CheckItemResult>,
      comment: String(payload["comment"] ?? ""),
      photoNote: (payload["photoNote"] as string | null) ?? null,
      isOffline: false,
      idempotencyKey: mutation.idempotencyKey,
    });
    return { status: "synced", createdEntityId: res.check.id };
  }

  if (mutation.entityType === "attachment" && mutation.operation === "upload_attachment") {
    const attachmentId = String(payload["attachmentId"] ?? mutation.entityId ?? "");
    const attachments = await listAttachments(session.businessId, session.userId);
    const att = attachments.find((a) => a.id === attachmentId);
    if (!att) {
      return { status: "synced" };
    }

    // If this attachment depended on an offline parent mutation, bind the resolved server ID
    if (mutation.dependsOnMutationId && resolvedParentIds.has(mutation.dependsOnMutationId)) {
      att.linkedEntityId = resolvedParentIds.get(mutation.dependsOnMutationId)!;
    }

    att.uploadStatus = "uploading";
    await putAttachment(att);

    const storagePath = `${session.businessId}/${att.linkedEntityType}/${att.linkedEntityId}/${att.id}-${att.fileName}`;
    if (isSupabaseConfigured && supabase) {
      const bytes = dataUrlToBytes(att.dataUrl);
      const { error } = await supabase.storage
        .from("worktrack-evidence")
        .upload(storagePath, bytes, { contentType: att.mimeType, upsert: true });
      if (error) {
        att.uploadStatus = "failed";
        att.lastError = error.message;
        await putAttachment(att);
        throw new Error(`Attachment upload failed: ${error.message}`);
      }
    }

    att.uploadStatus = "uploaded";
    att.storagePath = storagePath;
    att.uploadedAt = new Date().toISOString();
    att.lastError = null;
    await putAttachment(att);
    return { status: "synced", createdEntityId: att.id };
  }

  throw new Error(`Unsupported offline mutation: ${mutation.entityType}/${mutation.operation}`);
}

/**
 * Runs the partitioned offline sync engine:
 * - Requires active session and online connectivity (never silently drops drafts).
 * - Processes parent records before dependent attachments.
 * - Enforces idempotency keys (T19) and revision conflict checks (T20).
 */
export async function runSyncEngine(
  session: AuthSession | null,
  options?: { isOnline?: boolean; forceRetry?: boolean },
): Promise<SyncRunSummary> {
  const completedAt = new Date().toISOString();
  if (!session) {
    return { attempted: 0, synced: 0, conflicts: 0, failed: 0, skippedOffline: true, completedAt };
  }
  const online =
    options?.isOnline ?? (typeof navigator !== "undefined" ? navigator.onLine : true);
  if (!online) {
    return { attempted: 0, synced: 0, conflicts: 0, failed: 0, skippedOffline: true, completedAt };
  }

  const allMutations = await listMutations(session.businessId, session.userId);
  const ordered = sortMutationsByDependency(allMutations);
  const syncedIds = new Set(
    allMutations.filter((m) => m.status === "synced").map((m) => m.id),
  );
  const resolvedParentIds = new Map<string, string>();

  let attempted = 0;
  let synced = 0;
  let conflicts = 0;
  let failed = 0;
  const nowMs = Date.now();

  for (const m of ordered) {
    if (m.status === "synced" || m.status === "conflict") continue;
    if (!options?.forceRetry && m.attempts >= m.maxAttempts) continue;
    if (!options?.forceRetry && m.nextRetryAt && Date.parse(m.nextRetryAt) > nowMs) continue;
    if (m.dependsOnMutationId && !syncedIds.has(m.dependsOnMutationId)) {
      // Parent has not synced yet; keep queued until dependency succeeds
      continue;
    }

    attempted += 1;
    m.status = "syncing";
    m.updatedAt = new Date().toISOString();
    await putMutation(m);

    try {
      const res = await executeMutation(session, m, resolvedParentIds);
      if (res.status === "conflict" && res.conflict) {
        m.status = "conflict";
        m.lastError = `Server is at revision ${res.conflict.serverRevision} (local edit was based on revision ${res.conflict.baseRevision}).`;
        m.updatedAt = new Date().toISOString();
        await putMutation(m);
        await putConflict(res.conflict);
        conflicts += 1;
      } else {
        m.status = "synced";
        m.syncedAt = new Date().toISOString();
        m.updatedAt = m.syncedAt;
        m.lastError = null;
        if (res.createdEntityId) {
          m.entityId = res.createdEntityId;
          resolvedParentIds.set(m.id, res.createdEntityId);
        }
        await putMutation(m);
        syncedIds.add(m.id);
        synced += 1;
      }
    } catch (err) {
      m.attempts += 1;
      m.status = "failed";
      m.lastError = err instanceof Error ? err.message : "Sync failed.";
      m.nextRetryAt = new Date(Date.now() + computeBackoffMs(m.attempts)).toISOString();
      m.updatedAt = new Date().toISOString();
      await putMutation(m);
      failed += 1;
    }
  }

  const finishedAt = new Date().toISOString();
  if (synced > 0 || attempted === 0) {
    await setLastSyncAt(session.businessId, session.userId, finishedAt);
  }
  return { attempted, synced, conflicts, failed, skippedOffline: false, completedAt: finishedAt };
}

export async function resolveConflictRecord(
  session: AuthSession,
  conflictId: string,
  resolution: "keep_server" | "apply_local_as_new_revision",
): Promise<void> {
  const conflicts = await listConflicts(session.businessId, session.userId);
  const conflict = conflicts.find((c) => c.id === conflictId);
  if (!conflict) {
    throw new Error("Conflict record not found.");
  }

  const mutations = await listMutations(session.businessId, session.userId);
  const mutation = mutations.find((m) => m.id === conflict.mutationId);

  if (resolution === "apply_local_as_new_revision") {
    if (conflict.entityType === "expense") {
      const payload = conflict.localPayload;
      const res = await updateExpenseWithRevision(
        session,
        conflict.entityId,
        conflict.serverRevision,
        {
          ...(payload["description"] !== undefined
            ? { description: String(payload["description"]) }
            : {}),
          ...(payload["supplierName"] !== undefined
            ? { supplierName: String(payload["supplierName"]) }
            : {}),
          ...(payload["reference"] !== undefined
            ? { reference: String(payload["reference"]) }
            : {}),
          ...(payload["missingReceiptReason"] !== undefined
            ? { missingReceiptReason: payload["missingReceiptReason"] as string | null }
            : {}),
        },
      );
      if (res.status === "conflict") {
        throw new Error(
          `Record changed again on server (now rev ${res.serverRevision}). Refresh and review before applying.`,
        );
      }
    }
  }

  if (mutation) {
    mutation.status = "synced";
    mutation.syncedAt = new Date().toISOString();
    mutation.updatedAt = mutation.syncedAt;
    mutation.lastError = null;
    await putMutation(mutation);
  }

  await deleteConflict(conflict.id);
}

/**
 * Clears protected local data for the signed-in user's partition on logout.
 */
export async function clearUserOfflineDataOnLogout(session: AuthSession): Promise<void> {
  await clearPartition(session.businessId, session.userId);
}