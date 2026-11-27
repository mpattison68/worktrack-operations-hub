import { Clock, ShieldAlert } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface DisabledIncrementNoticeProps {
  title: string;
  increment: "B" | "C" | "D" | "E" | "F";
  summary: string;
  acceptanceTests: string[];
}

export function DisabledIncrementNotice({
  title,
  increment,
  summary,
  acceptanceTests,
}: DisabledIncrementNoticeProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="border-border bg-card">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1.5 bg-status-info-bg text-status-info">
              <Clock className="h-3.5 w-3.5" />
              Scheduled for Increment {increment}
            </Badge>
            <Badge variant="outline" className="gap-1.5 bg-status-warn-bg text-status-warn">
              <ShieldAlert className="h-3.5 w-3.5" />
              Disabled in Increment A
            </Badge>
          </div>
          <CardTitle className="text-2xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{summary}</p>
          <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">Release gate coverage:</p>
            <p className="mt-1">
              Acceptance tests {acceptanceTests.join(", ")} (see <code>docs/specification.md</code>{" "}
              Section 21). No placeholder or mock data is enabled on this screen.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button asChild variant="default" className="touch-target">
              <Link to="/">Return to Overview</Link>
            </Button>
            <Button asChild variant="outline" className="touch-target">
              <Link to="/jobs">Open Jobs</Link>
            </Button>
            <Button asChild variant="outline" className="touch-target">
              <Link to="/workers">Open Workers</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}