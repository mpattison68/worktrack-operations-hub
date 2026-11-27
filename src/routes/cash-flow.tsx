import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/cash-flow")({
  head: () => ({
    meta: [
      { title: "Cash flow — WorkTrack" },
      { name: "description", content: "Balanced cash ledger and shortfall forecast (scheduled for Increment D)." },
      { property: "og:title", content: "Cash flow — WorkTrack" },
      { property: "og:description", content: "Balanced cash ledger and shortfall forecast (scheduled for Increment D)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Cash ledger & weekly cash forecast"
      increment="D"
      summary="Balanced postings across bank, cash, and restricted funding accounts, transfer matching, customer payment milestones, and weekly cash shortfall forecasting."
      acceptanceTests={["T12", "T14", "T16", "T17"]}
    />
  ),
});