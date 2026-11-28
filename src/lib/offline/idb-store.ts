import type { ConflictRecord, OfflineAttachment, OfflineMutation } from "@/lib/offline/types";

const DB_NAME = "worktrack_offline_v1";
const DB_VERSION = 1;
const STORE_MUTATIONS = "mutations";
const STORE_CONFLICTS = "conflicts";
const STORE_ATTACHMENTS = "attachments";
const STORE_META = "meta";

interface MetaRow {
  key: string;
  partitionKey: string;
  value: string;
}

export function makePartitionKey(businessId: string, userId: string): string {
  return `${businessId}::${userId}`;
}

// Fallback in-memory store for SSR or test environments without IndexedDB
const memMutations = new Map<string, OfflineMutation>();
const memConflicts = new Map<string, ConflictRecord>();
const memAttachments = new Map<string, OfflineAttachment>();
const memMeta = new Map<string, MetaRow>();

function hasIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_MUTATIONS)) {
        const store = db.createObjectStore(STORE_MUTATIONS, { keyPath: "id" });
        store.createIndex("by_partition", "partitionKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CONFLICTS)) {
        const store = db.createObjectStore(STORE_CONFLICTS, { keyPath: "id" });
        store.createIndex("by_partition", "partitionKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) {
        const store = db.createObjectStore(STORE_ATTACHMENTS, { keyPath: "id" });
        store.createIndex("by_partition", "partitionKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        const store = db.createObjectStore(STORE_META, { keyPath: "key" });
        store.createIndex("by_partition", "partitionKey", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

async function idbPut<T>(storeName: string, record: T): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB put failed for ${storeName}`));
  });
  db.close();
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB delete failed for ${storeName}`));
  });
  db.close();
}

async function idbListByPartition<T>(storeName: string, partitionKey: string): Promise<T[]> {
  const db = await openDb();
  const rows = await new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const idx = tx.objectStore(storeName).index("by_partition");
    const req = idx.getAll(partitionKey);
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error(`IndexedDB read failed for ${storeName}`));
  });
  db.close();
  return rows;
}

export async function putMutation(item: OfflineMutation): Promise<void> {
  if (!hasIndexedDb()) {
    memMutations.set(item.id, item);
    return;
  }
  await idbPut(STORE_MUTATIONS, item);
}

export async function listMutations(businessId: string, userId: string): Promise<OfflineMutation[]> {
  const pk = makePartitionKey(businessId, userId);
  const rows = hasIndexedDb()
    ? await idbListByPartition<OfflineMutation>(STORE_MUTATIONS, pk)
    : Array.from(memMutations.values()).filter((m) => m.partitionKey === pk);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteMutation(id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memMutations.delete(id);
    return;
  }
  await idbDelete(STORE_MUTATIONS, id);
}

export async function putConflict(item: ConflictRecord): Promise<void> {
  if (!hasIndexedDb()) {
    memConflicts.set(item.id, item);
    return;
  }
  await idbPut(STORE_CONFLICTS, item);
}

export async function listConflicts(businessId: string, userId: string): Promise<ConflictRecord[]> {
  const pk = makePartitionKey(businessId, userId);
  const rows = hasIndexedDb()
    ? await idbListByPartition<ConflictRecord>(STORE_CONFLICTS, pk)
    : Array.from(memConflicts.values()).filter((c) => c.partitionKey === pk);
  return rows.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

export async function deleteConflict(id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memConflicts.delete(id);
    return;
  }
  await idbDelete(STORE_CONFLICTS, id);
}

export async function putAttachment(item: OfflineAttachment): Promise<void> {
  if (!hasIndexedDb()) {
    memAttachments.set(item.id, item);
    return;
  }
  await idbPut(STORE_ATTACHMENTS, item);
}

export async function listAttachments(
  businessId: string,
  userId: string,
): Promise<OfflineAttachment[]> {
  const pk = makePartitionKey(businessId, userId);
  const rows = hasIndexedDb()
    ? await idbListByPartition<OfflineAttachment>(STORE_ATTACHMENTS, pk)
    : Array.from(memAttachments.values()).filter((a) => a.partitionKey === pk);
  return rows.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

export async function deleteAttachment(id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memAttachments.delete(id);
    return;
  }
  await idbDelete(STORE_ATTACHMENTS, id);
}

export async function getLastSyncAt(businessId: string, userId: string): Promise<string | null> {
  const pk = makePartitionKey(businessId, userId);
  const key = `${pk}::lastSyncAt`;
  if (!hasIndexedDb()) {
    return memMeta.get(key)?.value ?? null;
  }
  const rows = await idbListByPartition<MetaRow>(STORE_META, pk);
  return rows.find((r) => r.key === key)?.value ?? null;
}

export async function setLastSyncAt(
  businessId: string,
  userId: string,
  isoTimestamp: string,
): Promise<void> {
  const pk = makePartitionKey(businessId, userId);
  const row: MetaRow = { key: `${pk}::lastSyncAt`, partitionKey: pk, value: isoTimestamp };
  if (!hasIndexedDb()) {
    memMeta.set(row.key, row);
    return;
  }
  await idbPut(STORE_META, row);
}

/**
 * Clears all protected local offline data (mutations, conflicts, photos, sync metadata)
 * for a single (businessId, userId) partition — called on confirmed logout.
 */
export async function clearPartition(businessId: string, userId: string): Promise<void> {
  const pk = makePartitionKey(businessId, userId);
  if (!hasIndexedDb()) {
    for (const [k, v] of memMutations.entries()) if (v.partitionKey === pk) memMutations.delete(k);
    for (const [k, v] of memConflicts.entries()) if (v.partitionKey === pk) memConflicts.delete(k);
    for (const [k, v] of memAttachments.entries()) if (v.partitionKey === pk) memAttachments.delete(k);
    for (const [k, v] of memMeta.entries()) if (v.partitionKey === pk) memMeta.delete(k);
    return;
  }

  const [mutations, conflicts, attachments, meta] = await Promise.all([
    idbListByPartition<OfflineMutation>(STORE_MUTATIONS, pk),
    idbListByPartition<ConflictRecord>(STORE_CONFLICTS, pk),
    idbListByPartition<OfflineAttachment>(STORE_ATTACHMENTS, pk),
    idbListByPartition<MetaRow>(STORE_META, pk),
  ]);
  await Promise.all([
    ...mutations.map((m) => idbDelete(STORE_MUTATIONS, m.id)),
    ...conflicts.map((c) => idbDelete(STORE_CONFLICTS, c.id)),
    ...attachments.map((a) => idbDelete(STORE_ATTACHMENTS, a.id)),
    ...meta.map((r) => idbDelete(STORE_META, r.key)),
  ]);
}

/** Test helper to reset in-memory fallback between Vitest specs. */
export function resetInMemoryOfflineStore(): void {
  memMutations.clear();
  memConflicts.clear();
  memAttachments.clear();
  memMeta.clear();
}
export async function getPartitionMeta(businessId: string, userId: string, name: string): Promise<string | null> {
 const pk=makePartitionKey(businessId,userId), key=`${pk}::${name}`;
 const rows=hasIndexedDb()?await idbListByPartition<MetaRow>(STORE_META,pk):Array.from(memMeta.values());
 return rows.find(r=>r.key===key)?.value??null;
}
export async function setPartitionMeta(businessId: string,userId: string,name: string,value: string): Promise<void> {
 const pk=makePartitionKey(businessId,userId); const row={key:`${pk}::${name}`,partitionKey:pk,value};
 if(hasIndexedDb()) await idbPut(STORE_META,row); else memMeta.set(row.key,row);
}
