import { createFileRoute } from "@tanstack/react-router";
import { WeeklyReportPanel } from "@/components/WeeklyReportPanel";

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Reports — WorkTrack" },
      { name: "description", content: "Weekly Mon–Sun job report review, approval lock, and safe CSV/Excel/PDF exports." },
      { property: "og:title", content: "Reports — WorkTrack" },
      { property: "og:description", content: "Weekly Mon–Sun job report review, approval lock, and safe CSV/Excel/PDF exports." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WeeklyReportPanel,
});