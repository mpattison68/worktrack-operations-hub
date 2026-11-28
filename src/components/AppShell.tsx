import * as React from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  BarChart3,
  Briefcase,
  ClipboardList,
  CreditCard,
  FileText,
  HardHat,
  Home,
  Landmark,
  LogOut,
  MapPin,
  Menu,
  Receipt,
  Settings,
  Truck,
  Users,
  Wallet,
  Wifi,
  WifiOff,
  Database,
  FlaskConical,
} from "lucide-react";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { useOfflineSync } from "@/lib/offline/sync-context";
import { can } from "@/lib/permissions";
import { NotificationsPopover } from "@/components/NotificationsPopover";
import { SyncStatusPopover } from "@/components/SyncStatusPopover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PUBLIC_PATHS = new Set(["/auth", "/reset-password"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, loading, backendMode, connectionState, signOut } = useWorkTrackAuth();
  const {
    pendingCount,
    conflictCount,
    effectiveOnline,
    syncNow,
    clearLocalPartition,
  } = useOfflineSync();
  const [logoutConfirmOpen, setLogoutConfirmOpen] = React.useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const isPublicRoute = PUBLIC_PATHS.has(location.pathname);

  React.useEffect(() => {
    if (!loading && !session && !isPublicRoute) {
      navigate({ to: "/auth", replace: true });
    }
  }, [loading, session, isPublicRoute, navigate]);

  if (isPublicRoute) {
    return <>{children}</>;
  }

  if (loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="text-center">
          <p className="text-base font-semibold text-foreground">{en.app.name}</p>
          <p className="mt-1 text-sm text-muted-foreground">Loading session…</p>
        </div>
      </div>
    );
  }

  const handleSignOut = async () => {
    if (pendingCount > 0 || conflictCount > 0) {
      setLogoutConfirmOpen(true);
      return;
    }
    await clearLocalPartition();
    await signOut();
    navigate({ to: "/auth", replace: true });
  };

  const handleDiscardAndSignOut = async () => {
    setLogoutConfirmOpen(false);
    await clearLocalPartition();
    await signOut();
    navigate({ to: "/auth", replace: true });
  };

  const desktopNav = [
    { to: "/" as const, label: en.nav.overview, icon: Home, active: true, visible: true },
    { to: "/assessments" as const, label: en.nav.assessments, icon: MapPin, active: true, visible: true },
    { to: "/jobs" as const, label: en.nav.jobs, icon: Briefcase, active: true, visible: true },
    { to: "/work" as const, label: en.nav.work, icon: HardHat, active: true, visible: true },
    { to: "/workers" as const, label: en.nav.workers, icon: Users, active: true, visible: true },
    { to: "/payroll" as const, label: en.nav.payroll, icon: CreditCard, active: true, visible: can(session.role, "payroll.view") },
    { to: "/expenses" as const, label: en.nav.expenses, icon: Receipt, active: true, visible: true },
    { to: "/cash-flow" as const, label: en.nav.cashFlow, icon: Wallet, active: true, visible: can(session.role, "loans.view") },
    { to: "/loans" as const, label: en.nav.loans, icon: Landmark, active: true, visible: can(session.role, "loans.view") },
    { to: "/vehicles" as const, label: en.nav.vehicles, icon: Truck, active: true, visible: true },
    { to: "/reports" as const, label: en.nav.reports, icon: BarChart3, active: true, visible: true },
    { to: "/settings" as const, label: session.role === "supervisor" ? en.account.title : en.nav.settings, icon: Settings, active: true, visible: true },
  ].filter((item) => item.visible);

  const mobileNav = [
    { to: "/" as const, label: en.nav.home, icon: Home },
    { to: "/work" as const, label: en.nav.work, icon: HardHat },
    { to: "/workers" as const, label: en.nav.workers, icon: Users },
    { to: "/money" as const, label: en.nav.money, icon: Wallet },
    { to: "/more" as const, label: en.nav.more, icon: Menu },
  ];

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop Sidebar (spec Section 3) */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <div className="border-b border-sidebar-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <ClipboardList className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-display text-lg font-bold tracking-tight">
                {en.app.name}
              </p>
              <p className="truncate text-xs text-sidebar-foreground/70">{session.businessName}</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Primary navigation">
          {desktopNav.map((item) => {
            const Icon = item.icon;
            const isCurrent =
              item.to === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex min-h-11 items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isCurrent
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {!item.active && (
                  <span className="rounded bg-sidebar-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-sidebar-foreground/75">
                    Later
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border p-4">
          <p className="truncate text-sm font-semibold">{session.fullName}</p>
          <p className="truncate text-xs text-sidebar-foreground/70">{en.roles[session.role]}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSignOut}
            className="mt-3 w-full touch-target justify-center gap-2"
          >
            <LogOut className="h-4 w-4" />
            {en.nav.signOut}
          </Button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top connection, backend mode & role status bar */}
        <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 lg:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-display text-base font-bold lg:hidden">{en.app.name}</span>
              <Badge variant="outline" className="gap-1.5 text-xs">
                {effectiveOnline ? (
                  <>
                    <Wifi className="h-3.5 w-3.5 text-status-ok" />
                    <span>{en.app.online}</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3.5 w-3.5 text-status-danger" />
                    <span>{en.app.offline}</span>
                  </>
                )}
              </Badge>
              <Badge
                variant="outline"
                className={
                  backendMode === "supabase"
                    ? "gap-1.5 bg-status-ok-bg text-status-ok"
                    : "gap-1.5 bg-status-warn-bg text-status-warn"
                }
              >
                {backendMode === "supabase" ? (
                  <>
                    <Database className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{connectionState === "connected" ? en.app.supabaseMode : connectionState === "offline" ? "Server offline" : connectionState === "error" ? "Connection failed" : "Checking connection"}</span>
                    <span className="sm:hidden">{connectionState === "connected" ? "Connected" : "Not confirmed"}</span>
                  </>
                ) : (
                  <>
                    <FlaskConical className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{en.app.syntheticMode}</span>
                    <span className="sm:hidden">Synthetic Dev</span>
                  </>
                )}
              </Badge>
              <SyncStatusPopover />
            </div>

            <div className="flex items-center gap-2">
              <NotificationsPopover />
              <Badge variant="secondary" className="text-xs">
                {en.roles[session.role]}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSignOut}
                className="touch-target gap-1.5 lg:hidden"
                aria-label={en.nav.signOut}
              >
                <LogOut className="h-4 w-4" />
                <span className="text-xs">{en.nav.signOut}</span>
              </Button>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-5 pb-24 lg:px-8 lg:py-6 lg:pb-8">{children}</main>

        {/* Mobile Bottom Navigation (spec Section 3: Home, Work, Workers, Money, More) */}
        <nav
          aria-label="Mobile navigation"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card lg:hidden"
        >
          <div className="grid grid-cols-5">
            {mobileNav.map((item) => {
              const Icon = item.icon;
              const isCurrent =
                item.to === "/"
                  ? location.pathname === "/"
                  : location.pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2 text-xs font-medium ${
                    isCurrent ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <Icon className={`h-5 w-5 ${isCurrent ? "text-accent-foreground" : ""}`} />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      <AlertDialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsynced records on this device</AlertDialogTitle>
            <AlertDialogDescription>
              You have {pendingCount} pending offline{" "}
              {pendingCount === 1 ? "item" : "items"}
              {conflictCount > 0 ? ` and ${conflictCount} unresolved conflict(s)` : ""} saved on
              this device. Signing out clears protected local data for shared-device safety.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="touch-target">Stay signed in</AlertDialogCancel>
            {effectiveOnline && (
              <Button
                variant="secondary"
                className="touch-target"
                onClick={async () => {
                  await syncNow(true);
                  setLogoutConfirmOpen(false);
                }}
              >
                Sync now
              </Button>
            )}
            <AlertDialogAction
              onClick={() => void handleDiscardAndSignOut()}
              className="touch-target bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard & sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}