import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Reports — WorkTrack" },
      { name: "description", content: "Weekly reports and Excel/CSV/PDF exports (scheduled for Increment E)." },
      { property: "og:title", content: "Reports — WorkTrack" },
      { property: "og:description", content: "Weekly reports and Excel/CSV/PDF exports (scheduled for Increment E)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Weekly reports & exports"
      increment="E"
      summary="Auto-assembled Mon–Sun weekly job reports with submit/return/approve revision lock, safe CSV/Excel/PDF exports, and restricted worker statements."
      acceptanceTests={["T18"]}
    />
  ),
});