import {useOfflineSync} from "@/lib/offline/sync-context";
import {enqueueOfflineMutation} from "@/lib/offline/sync-engine";
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, ClipboardCheck } from "lucide-react";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import {
  approveAssessmentScope,
  listAssessmentsAndBenchmarks,
  returnAssessment,
  saveAssessmentDraft,
  syncOfflineWaypoints,
} from "@/lib/data/assessment-repository";
import { getOfflineWaypoints } from "@/lib/data/offline-waypoint-queue";
import { calculateAssessmentSizing } from "@/lib/domain/assessment-calc";
import type { SiteAssessment } from "@/lib/domain/assessment-types";
import { can } from "@/lib/permissions";
import { formatDateSA } from "@/lib/format";
import { AssessmentWizard } from "@/components/AssessmentWizard";
import { AssessmentReviewPanel } from "@/components/AssessmentReviewPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/assessments")({
  head: () => ({
    meta: [
      { title: "Assessments — WorkTrack" },
      { name: "description", content: "Site assessment wizard, sizing, budget, and scope approval." },
      { property: "og:title", content: "Assessments — WorkTrack" },
      { property: "og:description", content: "Site assessment wizard, sizing, budget, and scope approval." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AssessmentsPage,
});

function AssessmentsPage() {
  const { session } = useWorkTrackAuth();
  const queryClient = useQueryClient();
  const {effectiveOnline,refreshOfflineState}=useOfflineSync();
  const [mode, setMode] = React.useState<"list" | "wizard" | "review">("list");
  const [selected, setSelected] = React.useState<SiteAssessment | null>(null);

  const query = useQuery({
    queryKey: ["assessments", session?.businessId, session?.userId],
    queryFn: () => listAssessmentsAndBenchmarks(session!),
    enabled: Boolean(session),
  });

  if (!session) return null;

  const assessments = query.data?.assessments ?? [];
  const canApprove = can(session.role, "scope.approve");

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["assessments"] });
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  // Automatically synchronise any queued offline waypoints when connectivity returns
  React.useEffect(() => {
    if (!session || typeof window === "undefined") return;
    const runSync = async () => {
      if (!navigator.onLine) return;
      const queued = getOfflineWaypoints();
      const assessmentIds = [...new Set(queued.map((q) => q.assessmentId))];
      for (const id of assessmentIds) {
        try {
          const res = await syncOfflineWaypoints(session, id);
          if (res.syncedCount > 0) {
            toast.success(`Synced ${res.syncedCount} offline waypoint(s).`);
            await refresh();
          }
        } catch {
          // Keep queued for next retry
        }
      }
    };
    void runSync();
    window.addEventListener("online", runSync);
    return () => window.removeEventListener("online", runSync);
  }, [session?.userId, session?.businessId]);

  if (mode === "wizard") {
    return (
      <AssessmentWizard
        initial={selected}
        onCancel={() => setMode(selected ? "review" : "list")}
        onSyncOffline={async (assessmentId) => {
          try {
            const res = await syncOfflineWaypoints(session, assessmentId);
            setSelected(res.assessment);
            await refresh();
            toast.success(
              res.syncedCount > 0
                ? `Synced ${res.syncedCount} offline waypoint(s).`
                : "All waypoints already synced.",
            );
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not sync offline waypoints.");
          }
        }}
        onSave={async (data, submit) => {
          try {
            if(!effectiveOnline){await enqueueOfflineMutation(session,{entityType:'assessment_waypoint',operation:'update',entityId:data.id??null,label:`Assessment draft: ${data.name}`,payload:{input:{...data,id:data.id??crypto.randomUUID(),status:'draft'}},baseRevision:data.editVersion??0});await refreshOfflineState();toast.info('Draft and waypoints saved on phone. Reconnect to sync, then submit for review.');setMode('list');return;}
            const saved = await saveAssessmentDraft(session, data);
            await refresh();
            setSelected(saved);
            toast.success(submit ? "Assessment submitted to management." : "Assessment draft saved.");
            setMode(submit ? "review" : "list");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save assessment.");
          }
        }}
      />
    );
  }

  if (mode === "review" && selected) {
    const latest = assessments.find((a) => a.id === selected.id) ?? selected;
    return (
      <AssessmentReviewPanel
        assessment={latest}
        canApprove={canApprove}
        onClose={() => {
          setSelected(null);
          setMode("list");
        }}
        onEditScope={() => {
          setSelected(latest);
          setMode("wizard");
        }}
        onUpdatePlanning={async (updated) => {
          try {
            const saved = await saveAssessmentDraft(session, updated);
            setSelected(saved);
            await refresh();
            toast.success("Planning assumptions saved.");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save planning assumptions.");
          }
        }}
        onReturn={async (comment) => {
          try {
            const saved = await returnAssessment(session, latest.id, comment);
            setSelected(saved);
            await refresh();
            toast.success("Assessment returned to owner.");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not return assessment.");
          }
        }}
        onApprove={async (updated, reason) => {
          try {
            const saved = await approveAssessmentScope(session, updated, reason);
            setSelected(saved);
            await refresh();
            toast.success(`Scope approved (Revision ${saved.revision}).`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not approve scope.");
          }
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Site assessments</h1>
          <p className="text-sm text-muted-foreground">
            Assess proposed roads, size clearing area & effort, and approve baseline job scopes.
          </p>
        </div>
        {can(session.role, "assessments.create") && (
          <Button
            onClick={() => {
              setSelected(null);
              setMode("wizard");
            }}
            className="touch-target gap-2"
          >
            <Plus className="h-4 w-4" />
            Assess new job
          </Button>
        )}
      </div>

      {assessments.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No site assessments yet. Start a 7-step assessment to estimate a road job.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {assessments.map((a) => {
            const s = calculateAssessmentSizing({
              sections: a.sections,
              benchmarkProductivitySqm: a.benchmarkProductivitySqm,
              productiveCrewSize: a.productiveCrewSize,
              roadWorkerDailyRateCents: a.roadWorkerDailyRateCents,
              cookWeeklyRateCents: a.cookWeeklyRateCents,
              includeCook: a.includeCook,
              workdaysPerWeek: a.workdaysPerWeek,
              contractValueCents: a.contractValueCents,
              budgetLines: a.budgetLines,
            });
            return (
              <Card key={a.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{a.name}</span>
                      </CardTitle>
                      <CardDescription>{a.roadOrArea}</CardDescription>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Badge variant="outline" className="capitalize">{a.status}</Badge>
                      <Badge variant="secondary">Rev {a.revision}</Badge>
                      {a.routePoints && a.routePoints.length > 0 && (
                        <Badge variant="secondary">{a.routePoints.length} pts</Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-2 rounded bg-muted/50 p-2.5">
                    <span>Road: <strong className="tabular-money">{(s.roadLengthMeters / 1000).toFixed(2)} km</strong></span>
                    <span>Verge: <strong className="tabular-money">{(s.vergeLengthMeters / 1000).toFixed(2)} km</strong></span>
                    <span>Area: <strong className="tabular-money">{s.physicalAreaSqm.toLocaleString()} m²</strong></span>
                    <span>Effort: <strong className="tabular-money">{s.effortUnitsSqm.toLocaleString()} m²</strong></span>
                  </div>
                  {a.reviewComment && (
                    <p className="rounded bg-status-warn-bg px-2.5 py-1.5 text-status-warn">
                      Returned note: {a.reviewComment}
                    </p>
                  )}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-muted-foreground">Updated {formatDateSA(a.updatedAt)}</span>
                    <div className="flex gap-2">
                      {(a.status === "draft" || a.status === "returned") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelected(a);
                            setMode("wizard");
                          }}
                          className="h-9"
                        >
                          Resume wizard
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => {
                          setSelected(a);
                          setMode("review");
                        }}
                        className="h-9 gap-1.5"
                      >
                        <ClipboardCheck className="h-3.5 w-3.5" />
                        {canApprove ? "Review / budget" : "View summary"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}