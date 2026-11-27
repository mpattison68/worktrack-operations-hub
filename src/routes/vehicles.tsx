import { createFileRoute } from "@tanstack/react-router";
import { VehiclesPanel } from "@/components/VehiclesPanel";

export const Route = createFileRoute("/vehicles")({
  head: () => ({
    meta: [
      { title: "Vehicles & checks — WorkTrack" },
      { name: "description", content: "Daily truck pre-use safety checks, STOP DO NOT USE defect workflow, and vehicle register." },
      { property: "og:title", content: "Vehicles & checks — WorkTrack" },
      { property: "og:description", content: "Daily truck pre-use safety checks, STOP DO NOT USE defect workflow, and vehicle register." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VehiclesPanel,
});