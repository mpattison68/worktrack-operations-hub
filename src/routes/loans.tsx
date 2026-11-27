import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listFinanceBundle } from "@/lib/data/increment-d-repository";
import { can } from "@/lib/permissions";
import { LoansPanel } from "@/components/LoansPanel";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/loans")({
  head: () => ({
    meta: [
      { title: "Loans — WorkTrack" },
      { name: "description", content: "Zero-interest loan account tracking, repayments, and restricted funding guards." },
      { property: "og:title", content: "Loans — WorkTrack" },
      { property: "og:description", content: "Zero-interest loan account tracking, repayments, and restricted funding guards." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LoansPage,
});

function LoansPage() {
  const { session } = useWorkTrackAuth();
  const canViewLoans = can(session?.role, "loans.view");

  const financeQuery = useQuery({
    queryKey: ["finance", session?.businessId, session?.userId],
    queryFn: () => listFinanceBundle(session!),
    enabled: Boolean(session && canViewLoans),
  });

  if (!session) return null;

  if (!canViewLoans) {
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
        <h1 className="text-2xl font-bold tracking-tight">{en.finance.loansTitle}</h1>
        <p className="text-sm text-muted-foreground">{en.finance.loansSubtitle}</p>
      </div>
      {financeQuery.data ? (
        <LoansPanel session={session} finance={financeQuery.data} />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading loan account...
          </CardContent>
        </Card>
      )}
    </div>
  );
}