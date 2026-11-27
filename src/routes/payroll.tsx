import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/payroll")({
  head: () => ({
    meta: [
      { title: "Payroll — WorkTrack" },
      { name: "description", content: "Weekly attendance and server-side payroll (scheduled for Increment C)." },
      { property: "og:title", content: "Payroll — WorkTrack" },
      { property: "og:description", content: "Weekly attendance and server-side payroll (scheduled for Increment C)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Weekly attendance & payroll"
      increment="C"
      summary="Mon–Sun team attendance pattern with individual worker exceptions, effective-dated rate splits, integer-cent gross/net earnings calculation, and restricted worker statements."
      acceptanceTests={["T07", "T08", "T09", "T10", "T11", "T25"]}
    />
  ),
});