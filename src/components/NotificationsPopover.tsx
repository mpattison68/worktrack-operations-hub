import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, Bell, Check, Info, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkTrackAuth } from "@/lib/auth-context";
import { listFinanceBundle } from "@/lib/data/increment-d-repository";
import {
  listIncrementEBundle,
  markNotificationReadOrAck,
  syncNotifications,
  updateNotificationPreferences,
} from "@/lib/data/increment-e-repository";
import {
  calculateLoanBalanceCents,
  calculateWeeklyCashForecast,
  computeCashSummary,
} from "@/lib/domain/finance-calc";
import { evaluateBusinessAlerts } from "@/lib/domain/increment-e-calc";
import { can } from "@/lib/permissions";
import { formatDateSA, getMonSunWeekRange, parseZarToCents, todaySAST } from "@/lib/format";
import { en } from "@/i18n/en";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const FINANCIAL_ALERT_TYPES = new Set([
  "cash_shortfall",
  "expense_large",
  "loan_repayment_due",
]);

export function NotificationsPopover() {
  const { session } = useWorkTrackAuth();
  const qc = useQueryClient();
  const canFinancial = can(session?.role, "loans.view");
  const [open, setOpen] = React.useState(false);
  const [prefsOpen, setPrefsOpen] = React.useState(false);

  const incEQuery = useQuery({
    queryKey: ["increment-e", session?.businessId, session?.userId],
    queryFn: () => listIncrementEBundle(session!),
    enabled: Boolean(session),
  });
  const financeQuery = useQuery({
    queryKey: ["finance", session?.businessId, session?.userId],
    queryFn: () => listFinanceBundle(session!),
    enabled: Boolean(session && canFinancial),
  });

  const evaluated = React.useMemo(() => {
    if (!session || !incEQuery.data) return [];
    const finance = financeQuery.data;
    let forecast = null;
    let loanBalanceCents = 0;
    if (canFinancial && finance) {
      const cash = computeCashSummary(finance.accounts, finance.journalEntries);
      const week = getMonSunWeekRange(todaySAST());
      forecast = calculateWeeklyCashForecast({
        openingUnrestrictedCashCents: cash.unrestrictedCashCents,
        weeklyCashCostCents: 2850000,
        weeksCount: 6,
        startWeekDate: week.start,
        expectedReceipts: finance.milestones
          .filter((m) => m.status !== "received")
          .slice(0, 2)
          .map((m, idx) => ({
            weekIndex: (idx + 1) * 3,
            amountCents: Math.max(0, m.expectedAmountCents - m.receivedAmountCents),
            label: m.label,
          })),
      });
      const loan = finance.loans[0];
      if (loan) {
        loanBalanceCents = calculateLoanBalanceCents(loan, finance.loanEvents).remainingPrincipalCents;
      }
    }
    const all = evaluateBusinessAlerts({
      businessId: session.businessId,
      preferences: incEQuery.data.preferences,
      defects: incEQuery.data.defects,
      reports: incEQuery.data.reports,
      expenses: canFinancial ? (finance?.expenses ?? []) : [],
      forecast,
      loanBalanceCents,
      existingNotifications: incEQuery.data.notifications,
    });
    return canFinancial ? all : all.filter((n) => !FINANCIAL_ALERT_TYPES.has(n.type));
  }, [session, incEQuery.data, financeQuery.data, canFinancial]);

  // Persist newly evaluated deduplicated alerts once
  React.useEffect(() => {
    if (!session || !incEQuery.data) return;
    const existingKeys = new Set(incEQuery.data.notifications.map((n) => n.dedupKey));
    const hasNew = evaluated.some((n) => !existingKeys.has(n.dedupKey));
    if (hasNew) {
      void syncNotifications(session, evaluated).then(() => {
        qc.invalidateQueries({ queryKey: ["increment-e"] });
      });
    }
  }, [session, incEQuery.data, evaluated, qc]);

  const unreadCount = evaluated.filter((n) => !n.readAt).length;

  const ackMutation = useMutation({
    mutationFn: async ({ id, ack }: { id: string; ack: boolean }) => {
      if (!session) return;
      await markNotificationReadOrAck(session, id, ack);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["increment-e"] }),
  });

  const prefs = incEQuery.data?.preferences;
  const [thresholdInput, setThresholdInput] = React.useState("5000");
  const [reminderTime, setReminderTime] = React.useState("17:00");
  const [shortfallOn, setShortfallOn] = React.useState(true);
  const [missingReceiptOn, setMissingReceiptOn] = React.useState(true);
  const [smtpDigestOn, setSmtpDigestOn] = React.useState(false);

  React.useEffect(() => {
    if (prefs) {
      setThresholdInput(String(Math.round(prefs.largeExpenseThresholdCents / 100)));
      setReminderTime(prefs.weeklyReportReminderTimeSAST);
      setShortfallOn(prefs.cashShortfallAlertEnabled);
      setMissingReceiptOn(prefs.missingReceiptAlertEnabled);
      setSmtpDigestOn(prefs.smtpDigestEnabled);
    }
  }, [prefs]);

  const savePrefsMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");
      const cents = parseZarToCents(thresholdInput);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR threshold.");
      return updateNotificationPreferences(session, {
        largeExpenseThresholdCents: cents,
        weeklyReportReminderTimeSAST: reminderTime,
        cashShortfallAlertEnabled: shortfallOn,
        missingReceiptAlertEnabled: missingReceiptOn,
        smtpDigestEnabled: smtpDigestOn,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["increment-e"] });
      toast.success("Notification preferences saved.");
      setPrefsOpen(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!session) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="relative touch-target gap-1.5"
            aria-label={en.notifications.title}
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-status-danger px-1 text-[11px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 sm:w-96 p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold">{en.notifications.title}</p>
              <p className="text-[11px] text-muted-foreground">
                In-app active · SMTP {prefs?.smtpConfigured ? "configured" : "queued (not configured)"}
              </p>
            </div>
            {can(session.role, "notifications.configure") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setPrefsOpen(true);
                }}
                aria-label="Notification settings"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="max-h-96 divide-y divide-border overflow-y-auto">
            {evaluated.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">
                {en.notifications.empty}
              </p>
            ) : (
              evaluated.slice(0, 12).map((n) => (
                <div
                  key={n.id}
                  className={`space-y-1.5 p-3 text-xs ${!n.readAt ? "bg-muted/30" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      {n.severity === "critical" ? (
                        <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-status-danger" />
                      ) : n.severity === "warning" ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
                      ) : (
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div>
                        <p className="font-semibold text-foreground">{n.title}</p>
                        <p className="mt-0.5 text-muted-foreground">{n.body}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 pl-6">
                    <span className="text-[11px] text-muted-foreground">
                      {formatDateSA(n.createdAt)}
                      {n.acknowledgedAt ? ` · Ack by ${n.acknowledgedBy}` : ""}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Link
                        to={n.linkTo as "/"}
                        onClick={() => setOpen(false)}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        Open
                      </Link>
                      {!n.acknowledgedAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 text-[11px]"
                          onClick={() => ackMutation.mutate({ id: n.id, ack: true })}
                        >
                          <Check className="h-3 w-3" />
                          {en.notifications.acknowledge}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={prefsOpen} onOpenChange={setPrefsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{en.notifications.settingsTitle}</DialogTitle>
            <DialogDescription>
              Configure alert thresholds and weekly report reminder schedule (Africa/Johannesburg).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="pref-thresh">Large expense threshold (ZAR)</Label>
                <Input
                  id="pref-thresh"
                  value={thresholdInput}
                  onChange={(e) => setThresholdInput(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pref-time">Sunday reminder (SAST)</Label>
                <Input
                  id="pref-time"
                  type="time"
                  value={reminderTime}
                  onChange={(e) => setReminderTime(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="pref-shortfall">Cash shortfall alerts</Label>
              <Switch
                id="pref-shortfall"
                checked={shortfallOn}
                onCheckedChange={setShortfallOn}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="pref-receipt">Missing receipt alerts</Label>
              <Switch
                id="pref-receipt"
                checked={missingReceiptOn}
                onCheckedChange={setMissingReceiptOn}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="pref-smtp">Queue SMTP email digest</Label>
                <p className="text-xs text-muted-foreground">
                  Requires SMTP environment settings on the VM backend to deliver emails.
                </p>
              </div>
              <Switch id="pref-smtp" checked={smtpDigestOn} onCheckedChange={setSmtpDigestOn} />
            </div>
            <Badge variant="outline" className="text-xs">
              Alerts are deduplicated automatically by event key.
            </Badge>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrefsOpen(false)}>
              {en.common.cancel}
            </Button>
            <Button
              onClick={() => savePrefsMutation.mutate()}
              disabled={savePrefsMutation.isPending}
            >
              {en.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}