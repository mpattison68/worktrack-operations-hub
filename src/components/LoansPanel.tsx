import { FinanceMaintenancePanel } from "@/components/FinanceMaintenancePanel";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Landmark, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { AuthSession } from "@/lib/domain/types";
import type { FinanceBundle, LoanEventType } from "@/lib/domain/increment-d-types";
import {
  recordLoanEvent,
  recordRestrictedGrantReceipt,
  setLoanOpeningVerified,
} from "@/lib/data/increment-d-repository";
import { calculateLoanBalanceCents, computeCashSummary } from "@/lib/domain/finance-calc";
import { formatDateSA, formatZarCents, parseZarToCents, todaySAST } from "@/lib/format";
import { can } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface LoansPanelProps {
  session: AuthSession;
  finance: FinanceBundle;
}

export function LoansPanel({ session, finance }: LoansPanelProps) {
  const queryClient = useQueryClient();
  const loan = finance.loans[0] ?? null;
  const cashAccounts = React.useMemo(
    () => finance.accounts.filter((a) => a.isCashAccount),
    [finance.accounts],
  );
  const cashSummary = React.useMemo(
    () => computeCashSummary(finance.accounts, finance.journalEntries),
    [finance.accounts, finance.journalEntries],
  );

  const [evType, setEvType] = React.useState<LoanEventType>("repayment");
  const [evAmountRand, setEvAmountRand] = React.useState("");
  const [evDate, setEvDate] = React.useState(todaySAST());
  const [evAccId, setEvAccId] = React.useState(cashAccounts[0]?.id ?? "");
  const [evRef, setEvRef] = React.useState("");
  const [evNote, setEvNote] = React.useState("");
  const [restrictedApproved, setRestrictedApproved] = React.useState(false);

  const [grantAmountRand, setGrantAmountRand] = React.useState("");
  const [grantRef, setGrantRef] = React.useState("");
  const [grantDesc, setGrantDesc] = React.useState("");

  React.useEffect(() => {
    if (!evAccId && cashAccounts[0]?.id) setEvAccId(cashAccounts[0].id);
  }, [evAccId, cashAccounts]);

  const selectedAccount = cashAccounts.find((a) => a.id === evAccId);
  const canEditLoans = can(session.role, "loans.edit");

  const loanEventMutation = useMutation({
    mutationFn: () => {
      if (!loan) throw new Error("No loan account configured.");
      const cents = parseZarToCents(evAmountRand);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR amount.");
      return recordLoanEvent(session, {
        loanId: loan.id,
        eventDate: evDate,
        eventType: evType,
        amountCents: cents,
        accountId: evAccId,
        restrictedEligibilityApproved: restrictedApproved,
        reference: evRef,
        note: evNote,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Loan event posted (zero interest, separate from operating expenses).");
      setEvAmountRand("");
      setEvRef("");
      setEvNote("");
      setRestrictedApproved(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record loan event."),
  });

  const grantMutation = useMutation({
    mutationFn: () => {
      const cents = parseZarToCents(grantAmountRand);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR grant amount.");
      return recordRestrictedGrantReceipt(session, {
        receiptDate: todaySAST(),
        amountCents: cents,
        reference: grantRef,
        description: grantDesc,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Restricted grant posted to separate restricted funding account.");
      setGrantAmountRand("");
      setGrantRef("");
      setGrantDesc("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record grant."),
  });

  const verifyPrincipalMutation = useMutation({
    mutationFn: (verified: boolean) => setLoanOpeningVerified(session, loan!.id, verified),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Opening loan principal verification updated.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update status."),
  });

  if (!loan) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No loan account configured for this business.
          <FinanceMaintenancePanel session={session} finance={finance} kind="loan"/>
        </CardContent>
      </Card>
    );
  }

  const summary = calculateLoanBalanceCents(loan, finance.loanEvents);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Landmark className="h-4 w-4 text-primary" />
              {loan.lenderName}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline">0% interest · R0 fees</Badge>
              <Badge
                variant="outline"
                className={
                  loan.openingPrincipalVerified
                    ? "gap-1 bg-status-ok-bg text-status-ok"
                    : "gap-1 bg-status-warn-bg text-status-warn"
                }
              >
                {loan.openingPrincipalVerified ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                {loan.openingPrincipalVerified ? "Opening principal verified" : "Opening principal unverified"}
              </Badge>
            </div>
          </div>
          <CardDescription className="text-xs">{loan.repaymentTermsNote}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">Opening principal</p>
              <p className="text-lg font-bold tabular-money">{formatZarCents(summary.openingPrincipalCents)}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">New advances</p>
              <p className="text-lg font-bold tabular-money">{formatZarCents(summary.totalAdvancesCents)}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">Repayments</p>
              <p className="text-lg font-bold tabular-money">{formatZarCents(summary.totalRepaymentsCents)}</p>
            </div>
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-xs text-muted-foreground">Remaining principal</p>
              <p className="text-lg font-bold tabular-money">{formatZarCents(summary.remainingPrincipalCents)}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Asset / security note: {loan.securityAssetNote}</span>
            {canEditLoans && !loan.openingPrincipalVerified && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => verifyPrincipalMutation.mutate(true)}
                className="h-9 gap-1.5 text-xs"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Mark opening principal verified
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {canEditLoans && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Record loan advance or repayment</CardTitle>
              <CardDescription className="text-xs">
                Advances increase cash and loan liability without changing worker arrears. Repayments reduce principal and never post to operating expenses.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  loanEventMutation.mutate();
                }}
                className="space-y-3"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>Event type</Label>
                    <Select value={evType} onValueChange={(v) => setEvType(v as LoanEventType)}>
                      <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="advance">New lender advance</SelectItem>
                        <SelectItem value="repayment">Principal repayment</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ln-amt">Amount (ZAR)</Label>
                    <Input id="ln-amt" inputMode="decimal" value={evAmountRand} onChange={(e) => setEvAmountRand(e.target.value)} className="touch-target tabular-money" required />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>Cash / funding account</Label>
                    <Select value={evAccId} onValueChange={setEvAccId}>
                      <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {cashAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name} ({formatZarCents(cashSummary.byAccountId[a.id] ?? 0)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ln-date">Date</Label>
                    <Input id="ln-date" type="date" value={evDate} onChange={(e) => setEvDate(e.target.value)} className="touch-target" required />
                  </div>
                </div>
                {selectedAccount?.isRestricted && evType === "repayment" && (
                  <div className="flex items-center gap-2 rounded-md border border-status-warn bg-status-warn-bg/50 p-2.5 text-xs">
                    <Checkbox
                      id="ln-restr"
                      checked={restrictedApproved}
                      onCheckedChange={(v) => setRestrictedApproved(Boolean(v))}
                    />
                    <Label htmlFor="ln-restr">
                      Grant terms explicitly permit debt repayment (required to unlock restricted funds)
                    </Label>
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input placeholder="Reference" value={evRef} onChange={(e) => setEvRef(e.target.value)} className="touch-target" />
                  <Input placeholder="Note" value={evNote} onChange={(e) => setEvNote(e.target.value)} className="touch-target" />
                </div>
                <Button type="submit" disabled={loanEventMutation.isPending} className="touch-target w-full">
                  Post loan {evType}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Record restricted grant funding</CardTitle>
              <CardDescription className="text-xs">
                Posted to the separate Restricted Funding account. Excluded from unrestricted cash and blocked from loan repayments unless eligible.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  grantMutation.mutate();
                }}
                className="space-y-3"
              >
                <div className="space-y-1">
                  <Label htmlFor="gr-amt">Grant amount (ZAR)</Label>
                  <Input id="gr-amt" inputMode="decimal" value={grantAmountRand} onChange={(e) => setGrantAmountRand(e.target.value)} className="touch-target tabular-money" required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="gr-ref">Grant reference</Label>
                  <Input id="gr-ref" placeholder="e.g. GRANT-2026-01" value={grantRef} onChange={(e) => setGrantRef(e.target.value)} className="touch-target" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="gr-desc">Permitted use / restriction note</Label>
                  <Input id="gr-desc" placeholder="e.g. Equipment & safety PPE only" value={grantDesc} onChange={(e) => setGrantDesc(e.target.value)} className="touch-target" required />
                </div>
                <Button type="submit" variant="outline" disabled={grantMutation.isPending} className="touch-target w-full">
                  Post restricted grant
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Loan event history ({finance.loanEvents.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {finance.loanEvents.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No loan advances or repayments posted yet.</p>
          ) : (
            finance.loanEvents.map((ev) => (
              <div key={ev.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-xs">
                <div>
                  <p className="text-sm font-semibold tabular-money">
                    {ev.eventType === "advance" ? "+" : "-"} {formatZarCents(ev.amountCents)} ({ev.eventType})
                  </p>
                  <p className="text-muted-foreground">
                    {formatDateSA(ev.eventDate)} · Ref: {ev.reference || "—"} · {ev.note || "No note"}
                  </p>
                </div>
                <Badge variant="outline">{ev.evidenceStatus}</Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}