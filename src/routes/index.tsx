import { createFileRoute } from "@tanstack/react-router";
import { ManagementDashboard } from "@/components/ManagementDashboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — WorkTrack" },
      {
        name: "description",
        content: "WorkTrack management dashboard, planned vs actual progress, cash forecast, and field operations overview.",
      },
      { property: "og:title", content: "Overview — WorkTrack" },
      {
        property: "og:description",
        content: "WorkTrack management dashboard, planned vs actual progress, cash forecast, and field operations overview.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ManagementDashboard,
});
