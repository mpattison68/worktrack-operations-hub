import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle2,
  FileText,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs } from "@/lib/data/repository";
import { useOfflineSync } from "@/lib/offline/sync-context";
import { prepareAttachmentFile } from "@/lib/offline/attachment-utils";
import { saveOfflineAttachment } from "@/lib/offline/sync-engine";
import { deleteAttachment } from "@/lib/offline/idb-store";
import { formatDateSA } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PhotosEvidencePanel() {
  const { session } = useWorkTrackAuth();
  const { attachments, effectiveOnline, isSyncing, refreshOfflineState, syncNow } =
    useOfflineSync();

  const [entityType, setEntityType] = React.useState<
    "expense" | "vehicle_check" | "progress_entry" | "assessment" | "job"
  >("job");
  const [selectedJobId, setSelectedJobId] = React.useState<string>("");
  const [linkedLabel, setLinkedLabel] = React.useState("");
  const [consentLocation, setConsentLocation] = React.useState(false);
  const [capturing, setCapturing] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const { data: jobs = [] } = useQuery({
    queryKey: ["jobs", session?.businessId],
    queryFn: () => (session ? listJobs(session) : Promise.resolve([])),
    enabled: Boolean(session),
  });

  React.useEffect(() => {
    if (!selectedJobId && jobs.length > 0 && jobs[0]) {
      setSelectedJobId(jobs[0].id);
    }
  }, [jobs, selectedJobId]);

  if (!session) return null;

  const getConsentedPosition = async (): Promise<{ lat: number; lng: number } | null> => {
    if (!consentLocation || typeof navigator === "undefined" || !("geolocation" in navigator)) {
      return null;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 4000 },
      );
    });
  };

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCapturing(true);
    try {
      const prepared = await prepareAttachmentFile(file);
      const coords = await getConsentedPosition();
      const job = jobs.find((j) => j.id === selectedJobId);
      const label =
        linkedLabel.trim() ||
        `${entityType.replace(/_/g, " ")} — ${job ? job.name : "General"}`;

      await saveOfflineAttachment(session, {
        linkedEntityType: entityType,
        linkedEntityId: selectedJobId || "general",
        linkedLabel: label,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.sizeBytes,
        sha256Checksum: prepared.sha256Checksum,
        dataUrl: prepared.dataUrl,
        exifStripped: prepared.exifStripped,
        locationConsented: consentLocation && coords !== null,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
      });

      await refreshOfflineState();
      setLinkedLabel("");
      if (effectiveOnline) {
        await syncNow(true);
      } else {
        toast.info("Saved on phone — will upload automatically when back online.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save photo or document.");
    } finally {
      setCapturing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemove = async (id: string) => {
    await deleteAttachment(id);
    await refreshOfflineState();
    toast.success("Removed local attachment.");
  };

  const pendingPhotos = attachments.filter((a) => a.uploadStatus !== "uploaded").length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Photos & receipt evidence</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Compressed images (EXIF stripped) and PDFs stored privately with SHA-256 checksums.
            Works offline and uploads once connectivity returns.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={isSyncing || !effectiveOnline || pendingPhotos === 0}
          onClick={() => void syncNow(true)}
          className="touch-target gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
          Upload pending ({pendingPhotos})
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Camera className="h-4 w-4" />
            Add photo or receipt PDF
          </CardTitle>
          <CardDescription>
            Allowlisted types: JPEG, PNG, WebP, PDF (max 10 MB). Stored in your private account
            partition on this device until uploaded to private storage.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="att-type">Evidence category</Label>
              <Select
                value={entityType}
                onValueChange={(v) => setEntityType(v as typeof entityType)}
              >
                <SelectTrigger id="att-type" className="touch-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="job">Site / job progress photo</SelectItem>
                  <SelectItem value="expense">Expense receipt</SelectItem>
                  <SelectItem value="vehicle_check">Vehicle / defect photo</SelectItem>
                  <SelectItem value="assessment">Site assessment photo</SelectItem>
                  <SelectItem value="progress_entry">Work strip evidence</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="att-job">Linked job</Label>
              <Select value={selectedJobId} onValueChange={setSelectedJobId}>
                <SelectTrigger id="att-job" className="touch-target">
                  <SelectValue placeholder="Select job" />
                </SelectTrigger>
                <SelectContent>
                  {jobs.map((job) => (
                    <SelectItem key={job.id} value={job.id}>
                      {job.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="att-label">Short note (optional)</Label>
            <Input
              id="att-label"
              value={linkedLabel}
              onChange={(e) => setLinkedLabel(e.target.value)}
              placeholder="e.g. Engen diesel slip or km 1.2 verge cleared"
              className="touch-target"
            />
          </div>

          <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted/40 p-3">
            <Checkbox
              id="att-location-consent"
              checked={consentLocation}
              onCheckedChange={(checked) => setConsentLocation(Boolean(checked))}
            />
            <div className="space-y-0.5">
              <Label htmlFor="att-location-consent" className="cursor-pointer text-sm font-medium">
                Attach one-time GPS location evidence (optional)
              </Label>
              <p className="text-xs text-muted-foreground">
                Camera EXIF metadata is stripped for privacy. Location is only stored separately
                when you tick this box.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              capture="environment"
              onChange={(e) => void handleFileSelected(e)}
              className="hidden"
            />
            <Button
              type="button"
              disabled={capturing}
              onClick={() => fileInputRef.current?.click()}
              className="touch-target gap-2"
            >
              <Camera className="h-4 w-4" />
              {capturing ? "Compressing & saving…" : "Take photo or choose file"}
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-status-ok" />
              Private bucket — no public links
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Saved evidence ({attachments.length})
          </CardTitle>
          <CardDescription>
            Clearly distinguishes files saved on your phone from files confirmed uploaded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attachments.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No photos or receipt PDFs captured on this device yet.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="flex flex-col justify-between gap-3 rounded-md border border-border bg-card p-3"
                >
                  <div className="flex items-start gap-3">
                    {att.mimeType === "application/pdf" ? (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-muted">
                        <FileText className="h-6 w-6 text-muted-foreground" />
                      </div>
                    ) : (
                      <img
                        src={att.dataUrl}
                        alt={att.linkedLabel}
                        className="h-14 w-14 shrink-0 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate text-sm font-medium">{att.linkedLabel}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {att.fileName} • {(att.sizeBytes / 1024).toFixed(1)} KB
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {att.uploadStatus === "uploaded" ? (
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <CheckCircle2 className="h-3 w-3 text-status-ok" />
                            Uploaded
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 text-[10px] text-status-warn">
                            <Smartphone className="h-3 w-3" />
                            Saved on phone
                          </Badge>
                        )}
                        {att.exifStripped && (
                          <Badge variant="outline" className="text-[10px]">
                            EXIF stripped
                          </Badge>
                        )}
                        {att.locationConsented && att.latitude !== null && (
                          <Badge variant="outline" className="gap-1 text-[10px]">
                            <MapPin className="h-3 w-3" />
                            GPS tagged
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                    <span className="truncate font-mono" title={att.sha256Checksum}>
                      SHA-256: {att.sha256Checksum.slice(0, 12)}… •{" "}
                      {formatDateSA(att.capturedAt.slice(0, 10))}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRemove(att.id)}
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${att.fileName}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}