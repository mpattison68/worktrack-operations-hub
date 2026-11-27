import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listJobs } from "@/lib/data/repository";
import { listFinanceBundle } from "@/lib/data/increment-d-repository";
import { ExpensesPanel } from "@/components/ExpensesPanel";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/expenses")({
  head: () => ({
    meta: [
      { title: "Expenses — WorkTrack" },
      { name: "description", content: "Capture operating and capital expenses with receipt evidence." },
      { property: "og:title", content: "Expenses — WorkTrack" },
      { property: "og:description", content: "Capture operating and capital expenses with receipt evidence." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ExpensesPage,
});

function ExpensesPage() {
  const { session } = useWorkTrackAuth();
  const financeQuery = useQuery({
    queryKey: ["finance", session?.businessId, session?.userId],
    queryFn: () => listFinanceBundle(session!),
    enabled: Boolean(session),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs", session?.businessId, session?.userId],
    queryFn: () => listJobs(session!),
    enabled: Boolean(session),
  });

  if (!session) return null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{en.finance.expensesTitle}</h1>
        <p className="text-sm text-muted-foreground">{en.finance.expensesSubtitle}</p>
      </div>
      {financeQuery.data ? (
        <ExpensesPanel session={session} finance={financeQuery.data} jobs={jobsQuery.data ?? []} />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading expenses...
          </CardContent>
        </Card>
      )}
    </div>
  );
}