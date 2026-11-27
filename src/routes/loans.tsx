import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/loans")({
  head: () => ({
    meta: [
      { title: "Loans — WorkTrack" },
      { name: "description", content: "Loan account tracking and repayment milestones (scheduled for Increment D)." },
      { property: "og:title", content: "Loans — WorkTrack" },
      { property: "og:description", content: "Loan account tracking and repayment milestones (scheduled for Increment D)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Loan account & repayment tracking"
      increment="D"
      summary="Zero-interest loan principal, approved advances, verified repayments separate from operating expenses, restricted funding checks, and due-date alerts."
      acceptanceTests={["T12", "T15", "T16", "T21"]}
    />
  ),
});