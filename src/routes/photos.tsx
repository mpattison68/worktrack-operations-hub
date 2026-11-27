import { createFileRoute } from "@tanstack/react-router";
import { PhotosEvidencePanel } from "@/components/PhotosEvidencePanel";

export const Route = createFileRoute("/photos")({
  head: () => ({
    meta: [
      { title: "Photos & evidence — WorkTrack" },
      { name: "description", content: "Private compressed photo and receipt evidence with offline upload queue." },
      { property: "og:title", content: "Photos & evidence — WorkTrack" },
      { property: "og:description", content: "Private compressed photo and receipt evidence with offline upload queue." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PhotosEvidencePanel,
});