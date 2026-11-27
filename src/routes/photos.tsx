import { createFileRoute } from "@tanstack/react-router";
import { DisabledIncrementNotice } from "@/components/DisabledIncrementNotice";

export const Route = createFileRoute("/photos")({
  head: () => ({
    meta: [
      { title: "Photos & evidence — WorkTrack" },
      { name: "description", content: "Private photo and receipt evidence (scheduled for Increment B/E)." },
      { property: "og:title", content: "Photos & evidence — WorkTrack" },
      { property: "og:description", content: "Private photo and receipt evidence (scheduled for Increment B/E)." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DisabledIncrementNotice
      title="Private photo & receipt evidence"
      increment="B"
      summary="Compressed photo capture with checksums, private Supabase Storage bucket, short-lived signed URLs, and offline attachment upload queue."
      acceptanceTests={["T23", "T26", "T27"]}
    />
  ),
});