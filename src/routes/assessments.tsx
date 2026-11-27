import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/assessments")({
  head: () => ({
    meta: [
      { title: "Assessments — WorkTrack" },
      { name: "description", content: "Site assessment wizard (scheduled for Increment B)." },
      { property: "og:title", content: "Assessments — WorkTrack" },
      { property: "og:description", content: "Site assessment wizard (scheduled for Increment B)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Site assessment & job sizing"
      increment="B"
      summary="7-step assessment wizard with GPS start/end and manual distance fallback, single/dual carriageway tappable strips (1–4 verges), clearing widths, difficulty factors, benchmark sizing, and admin scope approval."
      acceptanceTests={["T01", "T02", "T03", "T04", "T24"]}
    />
  ),
});