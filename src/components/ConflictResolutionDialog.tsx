import * as React from "react";
import { AlertTriangle, Check, GitCompare } from "lucide-react";
import type { ConflictRecord } from "@/lib/offline/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConflictResolutionDialogProps {
  conflict: ConflictRecord | null;
  onClose: () => void;
  onResolve: (
    conflictId: string,
    resolution: "keep_server" | "apply_local_as_new_revision",
  ) => Promise<void>;
}

function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key.endsWith("Cents") && typeof value === "number") {
    return `R ${(value / 100).toFixed(2)}`;
  }
  return String(value);
}

export function ConflictResolutionDialog({
  conflict,
  onClose,
  onResolve,
}: ConflictResolutionDialogProps) {
  const [submitting, setSubmitting] = React.useState(false);

  if (!conflict) return null;

  const fieldKeys = Array.from(
    new Set([
      ...Object.keys(conflict.localPayload),
      ...Object.keys(conflict.serverPayload),
    ]),
  );

  const handleResolve = async (resolution: "keep_server" | "apply_local_as_new_revision") => {
    setSubmitting(true);
    try {
      await onResolve(conflict.id, resolution);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={Boolean(conflict)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-5 w-5 text-status-warn" />
            Revision conflict — review required
          </DialogTitle>
          <DialogDescription>
            {conflict.entityLabel} was updated on the server while you were offline. WorkTrack
            never silently overwrites financial, payroll, or scope records.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-status-warn/40 bg-status-warn-bg/50 p-3 text-xs text-foreground">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-status-warn" />
            <span>
              Your offline edit was based on revision {conflict.baseRevision}, but the server is now
              at revision {conflict.serverRevision}.
            </span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Your local changes</p>
              <Badge variant="outline">Base rev {conflict.baseRevision}</Badge>
            </div>
            <dl className="space-y-1.5 text-xs">
              {fieldKeys.map((key) => (
                <div key={`local-${key}`} className="flex justify-between gap-2 border-b border-border/50 pb-1">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="text-right font-medium">
                    {formatFieldValue(key, conflict.localPayload[key])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Current server version</p>
              <Badge variant="secondary">Server rev {conflict.serverRevision}</Badge>
            </div>
            <dl className="space-y-1.5 text-xs">
              {fieldKeys.map((key) => (
                <div key={`server-${key}`} className="flex justify-between gap-2 border-b border-border/50 pb-1">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="text-right font-medium">
                    {formatFieldValue(key, conflict.serverPayload[key])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => void handleResolve("keep_server")}
            className="touch-target"
          >
            Keep server version (rev {conflict.serverRevision})
          </Button>
          <Button
            disabled={submitting}
            onClick={() => void handleResolve("apply_local_as_new_revision")}
            className="touch-target gap-1.5"
          >
            <Check className="h-4 w-4" />
            Apply my changes (rev {conflict.serverRevision + 1})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}