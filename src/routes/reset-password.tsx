import * as React from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset password — WorkTrack" },
      { name: "description", content: "Set a new password for your WorkTrack account." },
      { property: "og:title", content: "Reset password — WorkTrack" },
      { property: "og:description", content: "Set a new password for your WorkTrack account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [isRecovery, setIsRecovery] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    const hash = window.location.hash;
    setIsRecovery(hash.includes("type=recovery"));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSupabaseConfigured || !supabase) {
      toast.error("No Supabase backend is connected.");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated. You can now sign in.");
      navigate({ to: "/auth", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update password.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{en.auth.resetTitle}</CardTitle>
          <CardDescription>
            {isRecovery
              ? "Enter a new password for your WorkTrack account."
              : "Open this page using the recovery link sent to your email."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">{en.auth.newPasswordLabel}</Label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="touch-target"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">{en.auth.confirmPasswordLabel}</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="touch-target"
              />
            </div>
            <Button type="submit" disabled={submitting || !isRecovery} className="w-full touch-target">
              {en.auth.updatePasswordButton}
            </Button>
            <Button asChild variant="ghost" className="w-full touch-target">
              <Link to="/auth">{en.auth.backToSignIn}</Link>
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}