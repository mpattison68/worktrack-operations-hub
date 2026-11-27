import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/vehicles")({
  head: () => ({
    meta: [
      { title: "Vehicles & checks — WorkTrack" },
      { name: "description", content: "Daily truck safety checks and defects (scheduled for Increment E)." },
      { property: "og:title", content: "Vehicles & checks — WorkTrack" },
      { property: "og:description", content: "Daily truck safety checks and defects (scheduled for Increment E)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Vehicles, equipment & daily pre-use checks"
      increment="E"
      summary="Vehicle and brush-cutter register, daily oil/coolant/tyres/brakes checklist, immediate STOP DO NOT USE warning on critical defects, and authorized defect closure."
      acceptanceTests={["T22"]}
    />
  ),
});