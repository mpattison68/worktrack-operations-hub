import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/money")({
  head: () => ({
    meta: [
      { title: "Money — WorkTrack" },
      { name: "description", content: "Wage payments, expenses, and cash ledger (scheduled for Increment D)." },
      { property: "og:title", content: "Money — WorkTrack" },
      { property: "og:description", content: "Wage payments, expenses, and cash ledger (scheduled for Increment D)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Money, wage payments & expenses"
      increment="D"
      summary="Record wage payments with allocations, capture expenses and receipt photos, reconcile cash transfers without duplication, and track loan balances separately from operating costs."
      acceptanceTests={["T12", "T13", "T14", "T15", "T16", "T17", "T23"]}
    />
  ),
});