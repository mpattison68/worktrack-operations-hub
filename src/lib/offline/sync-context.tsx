import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import {
  getLastSyncAt,
  listAttachments,
  listConflicts,
  listMutations,
} from "@/lib/offline/idb-store";
import {
  clearUserOfflineDataOnLogout,
  resolveConflictRecord,
  runSyncEngine,
} from "@/lib/offline/sync-engine";
import type {
  ConflictRecord,
  OfflineAttachment,
  OfflineMutation,
  SyncRunSummary,
} from "@/lib/offline/types";

interface OfflineSyncContextValue {
  mutations: OfflineMutation[];
  conflicts: ConflictRecord[];
  attachments: OfflineAttachment[];
  pendingCount: number;
  conflictCount: number;
  lastSyncAt: string | null;
  isSyncing: boolean;
  workOfflineMode: boolean;
  effectiveOnline: boolean;
  setWorkOfflineMode: (offline: boolean) => void;
  refreshOfflineState: () => Promise<void>;
  syncNow: (forceRetry?: boolean) => Promise<SyncRunSummary | null>;
  resolveConflict: (
    conflictId: string,
    resolution: "keep_server" | "apply_local_as_new_revision",
  ) => Promise<void>;
  clearLocalPartition: () => Promise<void>;
}

const OfflineSyncContext = React.createContext<OfflineSyncContextValue | null>(null);

export function OfflineSyncProvider({ children }: { children: React.ReactNode }) {
  const { session, isOnline } = useWorkTrackAuth();
  const queryClient = useQueryClient();
  const [mutations, setMutations] = React.useState<OfflineMutation[]>([]);
  const [conflicts, setConflicts] = React.useState<ConflictRecord[]>([]);
  const [attachments, setAttachments] = React.useState<OfflineAttachment[]>([]);
  const [lastSyncAt, setLastSyncAt] = React.useState<string | null>(null);
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [workOfflineMode, setWorkOfflineMode] = React.useState(false);

  const effectiveOnline = isOnline && !workOfflineMode;
  const prevOnlineRef = React.useRef(effectiveOnline);

  const refreshOfflineState = React.useCallback(async () => {
    if (!session) {
      setMutations([]);
      setConflicts([]);
      setAttachments([]);
      setLastSyncAt(null);
      return;
    }
    const [muts, confs, atts, lastSync] = await Promise.all([
      listMutations(session.businessId, session.userId),
      listConflicts(session.businessId, session.userId),
      listAttachments(session.businessId, session.userId),
      getLastSyncAt(session.businessId, session.userId),
    ]);
    setMutations(muts);
    setConflicts(confs.filter((c) => c.resolvedAt === null));
    setAttachments(atts);
    setLastSyncAt(lastSync);
  }, [session]);

  React.useEffect(() => {
    void refreshOfflineState();
  }, [refreshOfflineState]);

  const syncNow = React.useCallback(
    async (forceRetry = false): Promise<SyncRunSummary | null> => {
      if (!session || isSyncing) return null;
      if (!effectiveOnline) {
        toast.info("You are offline. Records stay saved on this device until you reconnect.");
        return null;
      }
      setIsSyncing(true);
      try {
        const summary = await runSyncEngine(session, { isOnline: effectiveOnline, forceRetry });
        await refreshOfflineState();
        if (summary.synced > 0) {
          await queryClient.invalidateQueries();
          toast.success(
            `Synced ${summary.synced} offline ${summary.synced === 1 ? "record" : "records"}.`,
          );
        }
        if (summary.conflicts > 0) {
          toast.warning(
            `${summary.conflicts} revision ${summary.conflicts === 1 ? "conflict needs" : "conflicts need"} your review. No data was overwritten.`,
          );
        }
        if (summary.failed > 0) {
          toast.error(`${summary.failed} queued item(s) failed to sync and will retry.`);
        }
        return summary;
      } finally {
        setIsSyncing(false);
      }
    },
    [session, isSyncing, effectiveOnline, refreshOfflineState, queryClient],
  );

  // Automatically sync when connectivity returns
  React.useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = effectiveOnline;
    if (!wasOnline && effectiveOnline && session) {
      void syncNow(true);
    }
  }, [effectiveOnline, session, syncNow]);

  const resolveConflict = React.useCallback(
    async (conflictId: string, resolution: "keep_server" | "apply_local_as_new_revision") => {
      if (!session) return;
      await resolveConflictRecord(session, conflictId, resolution);
      await refreshOfflineState();
      await queryClient.invalidateQueries();
      toast.success(
        resolution === "keep_server"
          ? "Kept server version and cleared conflict."
          : "Applied your changes as a new revision.",
      );
    },
    [session, refreshOfflineState, queryClient],
  );

  const clearLocalPartition = React.useCallback(async () => {
    if (!session) return;
    await clearUserOfflineDataOnLogout(session);
    await refreshOfflineState();
  }, [session, refreshOfflineState]);

  const pendingCount = React.useMemo(
    () =>
      mutations.filter(
        (m) => m.status === "queued" || m.status === "syncing" || m.status === "failed",
      ).length,
    [mutations],
  );
  const conflictCount = conflicts.length;

  return (
    <OfflineSyncContext.Provider
      value={{
        mutations,
        conflicts,
        attachments,
        pendingCount,
        conflictCount,
        lastSyncAt,
        isSyncing,
        workOfflineMode,
        effectiveOnline,
        setWorkOfflineMode,
        refreshOfflineState,
        syncNow,
        resolveConflict,
        clearLocalPartition,
      }}
    >
      {children}
    </OfflineSyncContext.Provider>
  );
}

export function useOfflineSync(): OfflineSyncContextValue {
  const ctx = React.useContext(OfflineSyncContext);
  if (!ctx) throw new Error("useOfflineSync must be used inside OfflineSyncProvider.");
  return ctx;
}