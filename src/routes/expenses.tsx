import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/expenses")({
  head: () => ({
    meta: [
      { title: "Expenses — WorkTrack" },
      { name: "description", content: "Expense capture and receipt review (scheduled for Increment D)." },
      { property: "og:title", content: "Expenses — WorkTrack" },
      { property: "og:description", content: "Expense capture and receipt review (scheduled for Increment D)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Expenses & receipt evidence"
      increment="D"
      summary="Configurable expense categories, fuel unit-cost capture, receipt photo attachments, missing-receipt reasons, approval thresholds, and capital vs operating classification."
      acceptanceTests={["T19", "T23"]}
    />
  ),
});