import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FlaskConical, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listSyntheticAccounts, resetSyntheticStore } from "@/lib/data/repository";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — WorkTrack" },
      { name: "description", content: "Invitation-only sign in for WorkTrack." },
      { property: "og:title", content: "Sign in — WorkTrack" },
      { property: "og:description", content: "Invitation-only sign in for WorkTrack." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { session, backendMode, connectionState, signInWithPassword, signInSynthetic } = useWorkTrackAuth();
  const navigate = useNavigate();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [forgotMode, setForgotMode] = React.useState(false);
  const [syntheticAccounts, setSyntheticAccounts] = React.useState(() => import.meta.env.DEV ? listSyntheticAccounts() : []);

  React.useEffect(() => {
    if (session) {
      navigate({ to: "/", replace: true });
    }
  }, [session, navigate]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast.error("Enter your email address.");
      return;
    }
    if (forgotMode) {
      if (!isSupabaseConfigured || !supabase) {
        toast.info("Password reset requires a connected Supabase backend.");
        return;
      }
      setSubmitting(true);
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success(en.auth.resetSent);
        setForgotMode(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not send reset email.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!password) {
      toast.error("Enter your password.");
      return;
    }
    setSubmitting(true);
    try {
      await signInWithPassword(email.trim(), password);
      toast.success("Signed in.");
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyntheticSignIn = (membershipId: string) => {
    try {
      signInSynthetic(membershipId);
      toast.success("Signed in to synthetic dev account.");
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign in.");
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-1 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{en.app.name}</h1>
          <p className="text-sm text-muted-foreground">{en.app.tagline}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              {forgotMode ? en.auth.forgotPassword : en.auth.title}
            </CardTitle>
            <CardDescription>{en.auth.subtitle}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/60 p-3 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
              <span>{en.auth.inviteOnlyNotice}</span>
            </div>

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="auth-email">{en.auth.emailLabel}</Label>
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.co.za"
                  className="touch-target"
                />
              </div>

              {!forgotMode && (
                <div className="space-y-1.5">
                  <Label htmlFor="auth-password">{en.auth.passwordLabel}</Label>
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="touch-target"
                  />
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting || (backendMode !== "supabase" && !forgotMode)}
                className="w-full touch-target"
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {forgotMode ? en.auth.sendResetLink : en.auth.signInButton}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setForgotMode((v) => !v)}
                className="w-full touch-target text-xs"
              >
                {forgotMode ? en.auth.backToSignIn : en.auth.forgotPassword}
              </Button>
            </form>
          </CardContent>
        </Card>

        {backendMode === "unconfigured" && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">Backend connection is not configured. No demonstration data is available in production.</p>}
        {connectionState === "error" && backendMode === "supabase" && <p role="alert" className="text-sm text-destructive">Connection could not be confirmed. Check your connection and try again.</p>}
        {backendMode === "synthetic_dev" && (
          <Card className="border-status-warn/40 bg-card">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="gap-1.5 bg-status-warn-bg text-status-warn">
                  <FlaskConical className="h-3.5 w-3.5" />
                  Synthetic Dev Only
                </Badge>
              </div>
              <CardTitle className="text-lg">{en.auth.syntheticHeading}</CardTitle>
              <CardDescription className="text-xs">{en.auth.syntheticDescription}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {syntheticAccounts.map((acc) => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => handleSyntheticSignIn(acc.id)}
                  className="flex w-full touch-target items-center justify-between rounded-md border border-border bg-background px-3 py-2.5 text-left transition-colors hover:bg-muted"
                >
                  <div className="min-w-0 pr-2">
                    <p className="truncate text-sm font-semibold text-foreground">{acc.fullName}</p>
                    <p className="truncate text-xs text-muted-foreground">{acc.businessName}</p>
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    {en.roles[acc.role]}
                  </Badge>
                </button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  resetSyntheticStore();
                  setSyntheticAccounts(listSyntheticAccounts());
                  toast.success("Synthetic dev fixtures reset.");
                }}
                className="mt-2 w-full text-xs"
              >
                Reset synthetic fixtures
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}