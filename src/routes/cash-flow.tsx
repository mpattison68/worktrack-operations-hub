import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs } from "@/lib/data/repository";
import { listFinanceBundle } from "@/lib/data/increment-d-repository";
import { can } from "@/lib/permissions";
import { CashFlowPanel } from "@/components/CashFlowPanel";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/cash-flow")({
  head: () => ({
    meta: [
      { title: "Cash flow — WorkTrack" },
      { name: "description", content: "Balanced cash ledger, transfer matching, customer receipts, and shortfall forecast." },
      { property: "og:title", content: "Cash flow — WorkTrack" },
      { property: "og:description", content: "Balanced cash ledger, transfer matching, customer receipts, and shortfall forecast." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CashFlowPage,
});

function CashFlowPage() {
  const { session } = useWorkTrackAuth();
  const canViewCash = can(session?.role, "loans.view");

  const financeQuery = useQuery({
    queryKey: ["finance", session?.businessId, session?.userId],
    queryFn: () => listFinanceBundle(session!),
    enabled: Boolean(session && canViewCash),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session && canViewCash),
  });

  if (!session) return null;

  if (!canViewCash) {
    return (
      <Card className="mx-auto max-w-2xl border-status-warn/40 bg-status-warn-bg">
        <CardContent className="flex items-center gap-2 p-4 text-sm text-status-warn">
          <ShieldAlert className="h-5 w-5 shrink-0" />
          <span>{en.finance.accessDenied}</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{en.finance.cashFlowTitle}</h1>
        <p className="text-sm text-muted-foreground">{en.finance.cashFlowSubtitle}</p>
      </div>
      {financeQuery.data ? (
        <CashFlowPanel session={session} finance={financeQuery.data} jobs={jobsQuery.data ?? []} />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading cash ledger...
          </CardContent>
        </Card>
      )}
    </div>
  );
}