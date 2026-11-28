export type SyncEntityType =
  | "expense"
  | "vehicle_check"
  | "progress_entry"
  | "attendance"
  | "assessment_waypoint"
  | "attachment";

export type MutationOperation = "create" | "update" | "upload_attachment";

export type MutationStatus = "queued" | "syncing" | "synced" | "conflict" | "failed";

export type AttachmentUploadStatus = "saved_on_phone" | "uploading" | "uploaded" | "failed";

export interface OfflineMutation<TPayload = Record<string, unknown>> {
  id: string;
  clientUuid: string;
  idempotencyKey: string;
  dataEpoch?: number;
  businessId: string;
  userId: string;
  partitionKey: string;
  entityType: SyncEntityType;
  operation: MutationOperation;
  entityId: string | null;
  label: string;
  payload: TPayload;
  baseRevision: number | null;
  dependsOnMutationId: string | null;
  status: MutationStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

export interface ConflictRecord {
  id: string;
  mutationId: string;
  businessId: string;
  userId: string;
  partitionKey: string;
  entityType: SyncEntityType;
  entityId: string;
  entityLabel: string;
  baseRevision: number;
  serverRevision: number;
  localPayload: Record<string, unknown>;
  serverPayload: Record<string, unknown>;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: "keep_server" | "apply_local_as_new_revision" | null;
}

export interface OfflineAttachment {
  id: string;
  businessId: string;
  userId: string;
  partitionKey: string;
  linkedEntityType: "expense" | "vehicle_check" | "progress_entry" | "assessment" | "job";
  linkedEntityId: string;
  linkedLabel: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  sizeBytes: number;
  sha256Checksum: string;
  dataUrl: string;
  exifStripped: boolean;
  locationConsented: boolean;
  latitude: number | null;
  longitude: number | null;
  uploadStatus: AttachmentUploadStatus;
  storagePath: string | null;
  capturedAt: string;
  uploadedAt: string | null;
  lastError: string | null;
}

export interface SyncRunSummary {
  attempted: number;
  synced: number;
  conflicts: number;
  failed: number;
  skippedOffline: boolean;
  completedAt: string;
}