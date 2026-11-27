import { createFileRoute, Link } from "@tanstack/react-router";
import { Briefcase, Camera, FileText, MapPin, Settings, Truck } from "lucide-react";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { can } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/more")({
  head: () => ({
    meta: [
      { title: "More — WorkTrack" },
      { name: "description", content: "Additional WorkTrack workflows and settings." },
      { property: "og:title", content: "More — WorkTrack" },
      { property: "og:description", content: "Additional WorkTrack workflows and settings." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MorePage,
});

function MorePage() {
  const { session } = useWorkTrackAuth();
  if (!session) return null;

  const items = [
    { to: "/jobs" as const, label: en.nav.jobs, icon: Briefcase, badge: "Active", visible: true },
    { to: "/assessments" as const, label: en.nav.assessJob, icon: MapPin, badge: "Active", visible: true },
    { to: "/vehicles" as const, label: en.nav.truckCheck, icon: Truck, badge: "Increment E", visible: true },
    { to: "/photos" as const, label: en.nav.photos, icon: Camera, badge: "Increment B/E", visible: true },
    { to: "/reports" as const, label: en.nav.weeklyReport, icon: FileText, badge: "Increment E", visible: true },
    { to: "/settings" as const, label: en.nav.settings, icon: Settings, badge: "Active", visible: can(session.role, "business.view") },
  ].filter((i) => i.visible);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">{en.nav.more}</h1>
      <div className="space-y-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.to} to={item.to} className="block">
              <Card className="transition-colors hover:bg-muted/50">
                <CardContent className="flex min-h-14 items-center justify-between px-4 py-3">
                  <span className="flex items-center gap-3 text-base font-medium">
                    <Icon className="h-5 w-5 text-muted-foreground" />
                    {item.label}
                  </span>
                  <Badge variant={item.badge === "Active" ? "default" : "outline"}>
                    {item.badge}
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}