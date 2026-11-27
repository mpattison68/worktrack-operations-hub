import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  CloudUpload,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import { useOfflineSync } from "@/lib/offline/sync-context";
import type { ConflictRecord } from "@/lib/offline/types";
import { ConflictResolutionDialog } from "@/components/ConflictResolutionDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export function SyncStatusPopover() {
  const {
    mutations,
    conflicts,
    pendingCount,
    conflictCount,
    lastSyncAt,
    isSyncing,
    workOfflineMode,
    effectiveOnline,
    setWorkOfflineMode,
    syncNow,
    resolveConflict,
  } = useOfflineSync();
  const [activeConflict, setActiveConflict] = React.useState<ConflictRecord | null>(null);

  const recentItems = mutations.slice(-8).reverse();
  const totalAttention = pendingCount + conflictCount;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={conflictCount > 0 ? "destructive" : "outline"}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            aria-label="Sync status and offline queue"
          >
            {isSyncing ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : conflictCount > 0 ? (
              <AlertTriangle className="h-3.5 w-3.5" />
            ) : pendingCount > 0 ? (
              <Smartphone className="h-3.5 w-3.5 text-status-warn" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-status-ok" />
            )}
            <span className="hidden sm:inline">
              {conflictCount > 0
                ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`
                : pendingCount > 0
                  ? `${pendingCount} saved on phone`
                  : "All synced"}
            </span>
            {totalAttention > 0 && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px] sm:hidden">
                {totalAttention}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3 p-4 sm:w-96">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">Offline sync & queue</p>
              <p className="text-xs text-muted-foreground">
                {lastSyncAt
                  ? `Last synced: ${new Date(lastSyncAt).toLocaleTimeString("en-ZA", {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "Africa/Johannesburg",
                    })} SAST`
                  : "No sync run in this session yet"}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={isSyncing || !effectiveOnline}
              onClick={() => void syncNow(true)}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
              Sync now
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <CloudOff className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor="work-offline-toggle" className="cursor-pointer text-xs font-medium">
                Work offline (queue locally)
              </Label>
            </div>
            <Switch
              id="work-offline-toggle"
              checked={workOfflineMode}
              onCheckedChange={setWorkOfflineMode}
            />
          </div>

          {conflicts.length > 0 && (
            <div className="space-y-2 rounded-md border border-status-warn/50 bg-status-warn-bg/50 p-2.5">
              <p className="text-xs font-semibold text-foreground">
                Conflicts requiring review ({conflicts.length})
              </p>
              {conflicts.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 rounded bg-background/80 px-2 py-1.5 text-xs"
                >
                  <span className="truncate font-medium">{c.entityLabel}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => setActiveConflict(c)}
                  >
                    Resolve
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Device queue ({mutations.length} total)
            </p>
            {recentItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                No queued offline records on this device.
              </p>
            ) : (
              <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {recentItems.map((m) => (
                  <div
                    key={m.id}
                    className="rounded-md border border-border bg-card px-2.5 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{m.label}</span>
                      <Badge
                        variant={
                          m.status === "synced"
                            ? "secondary"
                            : m.status === "conflict" || m.status === "failed"
                              ? "destructive"
                              : "outline"
                        }
                        className="shrink-0 text-[10px]"
                      >
                        {m.status === "synced" ? (
                          <span className="flex items-center gap-1">
                            <CloudUpload className="h-3 w-3" /> Uploaded
                          </span>
                        ) : m.status === "queued" || m.status === "syncing" ? (
                          "Saved on phone"
                        ) : m.status === "conflict" ? (
                          "Conflict"
                        ) : (
                          `Retry (${m.attempts}/${m.maxAttempts})`
                        )}
                      </Badge>
                    </div>
                    {m.lastError && (
                      <p className="mt-1 text-[11px] text-status-danger">{m.lastError}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <ConflictResolutionDialog
        conflict={activeConflict}
        onClose={() => setActiveConflict(null)}
        onResolve={resolveConflict}
      />
    </>
  );
}