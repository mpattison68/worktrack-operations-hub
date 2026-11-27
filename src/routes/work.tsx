import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/work")({
  head: () => ({
    meta: [
      { title: "Work progress — WorkTrack" },
      { name: "description", content: "Daily work progress and interruptions (scheduled for Increment C)." },
      { property: "og:title", content: "Work progress — WorkTrack" },
      { property: "og:description", content: "Daily work progress and interruptions (scheduled for Increment C)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Daily work progress & interruptions"
      increment="C"
      summary="Capture daily/weekly chainage ranges per verge and activity with interval-merge progress, full-completion overlap calculation, rework logging, and weather/vehicle/fuel interruptions."
      acceptanceTests={["T05", "T06"]}
    />
  ),
});