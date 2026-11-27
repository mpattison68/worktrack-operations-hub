import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Scale, TrendingDown } from "lucide-react";
import { toast } from "sonner";
import type { AuthSession, Job } from "@/lib/domain/types";
import type { CashTransferRecord, FinanceBundle } from "@/lib/domain/increment-d-types";
import {
  recordCashReconciliation,
  recordCustomerMilestoneReceipt,
  recordOrMatchTransfer,
} from "@/lib/data/increment-d-repository";
import { calculateWeeklyCashForecast, computeCashSummary } from "@/lib/domain/finance-calc";
import { formatDateSA, formatZarCents, getMonSunWeekRange, parseZarToCents, todaySAST } from "@/lib/format";
import { can } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface CashFlowPanelProps {
  session: AuthSession;
  finance: FinanceBundle;
  jobs: Job[];
}

export function CashFlowPanel({ session, finance, jobs }: CashFlowPanelProps) {
  const queryClient = useQueryClient();
  const cashSummary = React.useMemo(
    () => computeCashSummary(finance.accounts, finance.journalEntries),
    [finance.accounts, finance.journalEntries],
  );
  const cashAccounts = React.useMemo(
    () => finance.accounts.filter((a) => a.isCashAccount),
    [finance.accounts],
  );
  const unrestrictedAccounts = React.useMemo(
    () => cashAccounts.filter((a) => !a.isRestricted),
    [cashAccounts],
  );

  // Transfer state
  const [tDate, setTDate] = React.useState(todaySAST());
  const [tKind, setTKind] = React.useState<CashTransferRecord["transferKind"]>("lender_advance");
  const [tFrom, setTFrom] = React.useState(unrestrictedAccounts[0]?.id ?? "");
  const [tTo, setTTo] = React.useState(unrestrictedAccounts[0]?.id ?? "");
  const [tAmountRand, setTAmountRand] = React.useState("");
  const [tRef, setTRef] = React.useState("");
  const [tDesc, setTDesc] = React.useState("");
  const [tNote, setTNote] = React.useState("");

  // Reconciliation state
  const [recAccId, setRecAccId] = React.useState(unrestrictedAccounts[0]?.id ?? "");
  const [recDate, setRecDate] = React.useState(todaySAST());
  const [recCountedRand, setRecCountedRand] = React.useState("");
  const [recNote, setRecNote] = React.useState("");

  // Milestone receipt state
  const [msAmounts, setMsAmounts] = React.useState<Record<string, string>>({});

  // Forecast what-if assumptions (never edits actuals)
  const [weeklyCostRand, setWeeklyCostRand] = React.useState("28500");
  const [delayWeeks, setDelayWeeks] = React.useState("0");
  const [arrearsRand, setArrearsRand] = React.useState("0");

  const currentMonday = getMonSunWeekRange(todaySAST()).start;

  const forecast = React.useMemo(() => {
    const weeklyCostCents = parseZarToCents(weeklyCostRand) ?? 2850000;
    const arrearsCents = parseZarToCents(arrearsRand) ?? 0;
    const expectedReceipts = finance.milestones
      .filter((m) => m.status !== "received")
      .map((m) => {
        const diffDays = Math.round(
          (new Date(m.expectedDate).getTime() - new Date(currentMonday).getTime()) / 86400000,
        );
        return {
          weekIndex: Math.max(0, Math.floor(diffDays / 7)),
          amountCents: Math.max(0, m.expectedAmountCents - m.receivedAmountCents),
          label: m.label,
        };
      });
    return calculateWeeklyCashForecast({
      openingUnrestrictedCashCents: cashSummary.unrestrictedCashCents,
      weeklyCashCostCents: Math.max(0, weeklyCostCents),
      weeksCount: 8,
      startWeekDate: currentMonday,
      expectedReceipts,
      existingArrearsCents: Math.max(0, arrearsCents),
      receiptDelayWeeks: Math.max(0, Number(delayWeeks) || 0),
    });
  }, [cashSummary.unrestrictedCashCents, weeklyCostRand, arrearsRand, delayWeeks, finance.milestones, currentMonday]);

  const transferMutation = useMutation({
    mutationFn: () => {
      const cents = parseZarToCents(tAmountRand);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR transfer amount.");
      return recordOrMatchTransfer(session, {
        transferDate: tDate,
        fromAccountId: tKind === "internal_transfer" ? tFrom : null,
        toAccountId: tTo,
        amountCents: cents,
        sharedReference: tRef,
        description: tDesc,
        transferKind: tKind,
        note: tNote,
      });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success(
        res.matchedExisting
          ? "Transfer matched! Exactly one balanced journal entry has been posted."
          : "Transfer recorded as pending match. The other party can confirm with the same reference and amount.",
      );
      setTAmountRand("");
      setTRef("");
      setTDesc("");
      setTNote("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record transfer."),
  });

  const reconcileMutation = useMutation({
    mutationFn: () => {
      const cents = parseZarToCents(recCountedRand);
      if (cents === null) throw new Error("Enter a valid ZAR counted/bank balance.");
      return recordCashReconciliation(session, {
        accountId: recAccId,
        reconciledDate: recDate,
        countedBalanceCents: cents,
        note: recNote,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Reconciliation recorded (no fabricated adjustment posted).");
      setRecCountedRand("");
      setRecNote("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record reconciliation."),
  });

  const receiptMutation = useMutation({
    mutationFn: (milestoneId: string) => {
      const cents = parseZarToCents(msAmounts[milestoneId] ?? "");
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR received amount.");
      return recordCustomerMilestoneReceipt(session, {
        milestoneId,
        receivedDate: todaySAST(),
        receivedAmountCents: cents,
        accountId: unrestrictedAccounts[0]?.id ?? "",
        reference: `RCPT-${todaySAST()}`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Customer receipt posted to bank ledger.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not post receipt."),
  });

  const canAdminReconcile = can(session.role, "payroll.reconcile");
  const accName = (id: string | null) =>
    finance.accounts.find((a) => a.id === id)?.name ?? "External / N/A";
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? "Job";

  return (
    <div className="space-y-4">
      {/* Account Balances Summary */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Unrestricted cash available</p>
            <p className="text-2xl font-bold tabular-money">{formatZarCents(cashSummary.unrestrictedCashCents)}</p>
            <p className="text-[11px] text-muted-foreground">Bank + cash on hand (excludes expected receipts &amp; grants)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Restricted funding (separate)</p>
            <p className="text-2xl font-bold tabular-money">{formatZarCents(cashSummary.restrictedCashCents)}</p>
            <p className="text-[11px] text-muted-foreground">Excluded from unrestricted cash &amp; debt repayment</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">8-week forecast peak shortfall</p>
            <p className={`text-2xl font-bold tabular-money ${forecast.peakShortfallCents > 0 ? "text-status-bad" : "text-status-ok"}`}>
              {forecast.peakShortfallCents > 0 ? formatZarCents(forecast.peakShortfallCents) : "R 0.00"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {forecast.earliestNegativeWeekDate
                ? `Earliest negative week: ${formatDateSA(forecast.earliestNegativeWeekDate)}`
                : "No shortfall projected"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="forecast" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-flex">
          <TabsTrigger value="forecast" className="touch-target">Cash forecast</TabsTrigger>
          <TabsTrigger value="transfers" className="touch-target">Transfers ({finance.transfers.length})</TabsTrigger>
          <TabsTrigger value="milestones" className="touch-target">Customer receipts</TabsTrigger>
          <TabsTrigger value="ledger" className="touch-target">Ledger &amp; reconcile</TabsTrigger>
        </TabsList>

        {/* TAB 1: WEEKLY CASH SHORTFALL FORECAST */}
        <TabsContent value="forecast" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingDown className="h-4 w-4 text-primary" />
                Weekly cash shortfall forecast (what-if assumptions)
              </CardTitle>
              <CardDescription className="text-xs">
                Adjusting assumptions models scenarios without editing actual ledger balances. Uses unrestricted cash only.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="fc-cost">Weekly cash outflows (ZAR)</Label>
                  <Input id="fc-cost" inputMode="decimal" value={weeklyCostRand} onChange={(e) => setWeeklyCostRand(e.target.value)} className="touch-target tabular-money" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fc-arr">Existing arrears to settle once (ZAR)</Label>
                  <Input id="fc-arr" inputMode="decimal" value={arrearsRand} onChange={(e) => setArrearsRand(e.target.value)} className="touch-target tabular-money" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fc-delay">Delay expected receipts by (weeks)</Label>
                  <Input id="fc-delay" type="number" min={0} max={8} value={delayWeeks} onChange={(e) => setDelayWeeks(e.target.value)} className="touch-target" />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="py-2 pr-3">Week</th>
                      <th className="py-2 pr-3 text-right">Opening</th>
                      <th className="py-2 pr-3 text-right">Expected receipts</th>
                      <th className="py-2 pr-3 text-right">Outflows</th>
                      <th className="py-2 text-right">Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecast.rows.map((row) => (
                      <tr key={row.weekIndex} className="border-b border-border/60">
                        <td className="py-2 pr-3 font-medium">
                          Wk {row.weekIndex + 1} ({formatDateSA(row.weekStartDate)})
                          {row.notes.length > 0 && (
                            <span className="block text-[11px] text-muted-foreground">{row.notes.join(" · ")}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-money">{formatZarCents(row.openingCashCents)}</td>
                        <td className="py-2 pr-3 text-right tabular-money">{formatZarCents(row.expectedReceiptsCents)}</td>
                        <td className="py-2 pr-3 text-right tabular-money">{formatZarCents(row.scheduledOutflowsCents)}</td>
                        <td className={`py-2 text-right font-semibold tabular-money ${row.closingCashCents < 0 ? "text-status-bad" : ""}`}>
                          {formatZarCents(row.closingCashCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 2: TRANSFER MATCHING (T14) */}
        <TabsContent value="transfers" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ArrowLeftRight className="h-4 w-4 text-primary" />
                Record or match cash transfer
              </CardTitle>
              <CardDescription className="text-xs">
                When both Management / Admin and Owner record the same shared reference and amount, WorkTrack matches them into a single ledger posting and keeps both sides&apos; evidence.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  transferMutation.mutate();
                }}
                className="space-y-3"
              >
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="space-y-1">
                    <Label>Transfer type</Label>
                    <Select value={tKind} onValueChange={(v) => setTKind(v as CashTransferRecord["transferKind"])}>
                      <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lender_advance">Lender advance</SelectItem>
                        <SelectItem value="internal_transfer">Internal bank ↔ cash</SelectItem>
                        <SelectItem value="owner_contribution">Owner contribution</SelectItem>
                        <SelectItem value="restricted_grant">Restricted grant</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tr-amt">Amount (ZAR)</Label>
                    <Input id="tr-amt" inputMode="decimal" value={tAmountRand} onChange={(e) => setTAmountRand(e.target.value)} className="touch-target tabular-money" required />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tr-ref">Shared reference</Label>
                    <Input id="tr-ref" placeholder="e.g. EFT-2026-01" value={tRef} onChange={(e) => setTRef(e.target.value)} className="touch-target" required />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tr-date">Date</Label>
                    <Input id="tr-date" type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} className="touch-target" required />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {tKind === "internal_transfer" && (
                    <div className="space-y-1">
                      <Label>From account</Label>
                      <Select value={tFrom} onValueChange={setTFrom}>
                        <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {unrestrictedAccounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label>Destination account</Label>
                    <Select value={tTo} onValueChange={setTTo}>
                      <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {cashAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tr-desc">Description / note</Label>
                    <Input id="tr-desc" value={tDesc} onChange={(e) => setTDesc(e.target.value)} className="touch-target" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" disabled={transferMutation.isPending} className="touch-target">
                    Record / match transfer
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {finance.transfers.map((t) => (
              <div key={t.id} className="rounded-md border border-border bg-card p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold tabular-money">
                    {formatZarCents(t.amountCents)} · {t.sharedReference}
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      t.status === "matched"
                        ? "gap-1 bg-status-ok-bg text-status-ok"
                        : "gap-1 bg-status-warn-bg text-status-warn"
                    }
                  >
                    {t.status === "matched" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                    {t.status === "matched" ? "Matched (1 posting)" : "Pending match"}
                  </Badge>
                </div>
                <p className="text-muted-foreground">
                  {formatDateSA(t.transferDate)} · {t.transferKind.replace(/_/g, " ")} → {accName(t.toAccountId)}
                </p>
                <p className="text-muted-foreground">
                  Admin: {t.reportedByAdmin ? t.reportedByAdmin.userId : "Waiting"} · Owner:{" "}
                  {t.confirmedByOwner ? t.confirmedByOwner.userId : "Waiting"}
                </p>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* TAB 3: CUSTOMER PAYMENT MILESTONES */}
        <TabsContent value="milestones" className="space-y-3">
          {finance.milestones.map((ms) => (
            <Card key={ms.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
                <div>
                  <p className="text-sm font-semibold">{ms.label}</p>
                  <p className="text-muted-foreground">
                    {jobName(ms.jobId)} · Expected {formatDateSA(ms.expectedDate)} ·{" "}
                    <strong className="tabular-money">{formatZarCents(ms.expectedAmountCents)}</strong>
                  </p>
                  <p className="text-muted-foreground">
                    Received: <strong className="tabular-money">{formatZarCents(ms.receivedAmountCents)}</strong>
                    {ms.receivedDate ? ` on ${formatDateSA(ms.receivedDate)}` : " (not counted in available cash yet)"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{ms.status}</Badge>
                  {canAdminReconcile && ms.status !== "received" && (
                    <>
                      <Input
                        inputMode="decimal"
                        placeholder="ZAR received"
                        value={msAmounts[ms.id] ?? ""}
                        onChange={(e) => setMsAmounts((p) => ({ ...p, [ms.id]: e.target.value }))}
                        className="h-9 w-32 tabular-money"
                      />
                      <Button size="sm" onClick={() => receiptMutation.mutate(ms.id)} className="h-9">
                        Post receipt
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* TAB 4: BALANCED LEDGER & MANUAL RECONCILIATION */}
        <TabsContent value="ledger" className="space-y-4">
          {canAdminReconcile && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Scale className="h-4 w-4 text-primary" />
                  Manual cash / bank reconciliation
                </CardTitle>
                <CardDescription className="text-xs">
                  Compare actual counted cash or bank statement balance against the ledger. Shows the exact difference without fabricating an adjustment.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    reconcileMutation.mutate();
                  }}
                  className="grid gap-3 sm:grid-cols-4"
                >
                  <Select value={recAccId} onValueChange={setRecAccId}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {cashAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name} ({formatZarCents(cashSummary.byAccountId[a.id] ?? 0)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input type="date" value={recDate} onChange={(e) => setRecDate(e.target.value)} className="touch-target" />
                  <Input inputMode="decimal" placeholder="Counted / bank ZAR" value={recCountedRand} onChange={(e) => setRecCountedRand(e.target.value)} className="touch-target tabular-money" required />
                  <Button type="submit" disabled={reconcileMutation.isPending} className="touch-target">Record check</Button>
                </form>
                {finance.reconciliations.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {finance.reconciliations.slice(0, 5).map((r) => (
                      <div key={r.id} className="flex flex-wrap items-center justify-between rounded bg-muted/40 px-2.5 py-2 text-xs">
                        <span>{accName(r.accountId)} · {formatDateSA(r.reconciledDate)}</span>
                        <span className="tabular-money">
                          Ledger {formatZarCents(r.ledgerBalanceCents)} vs Counted {formatZarCents(r.countedBalanceCents)} ·{" "}
                          <strong className={r.differenceCents === 0 ? "text-status-ok" : "text-status-warn"}>
                            Diff {formatZarCents(r.differenceCents)}
                          </strong>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Immutable balanced journal ({finance.journalEntries.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {finance.journalEntries.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No journal entries posted yet.</p>
              ) : (
                finance.journalEntries.map((je) => (
                  <div key={je.id} className="space-y-1 rounded-md border border-border p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{je.description}</span>
                      <Badge variant="outline">{je.sourceType.replace(/_/g, " ")}</Badge>
                    </div>
                    <p className="text-muted-foreground">
                      {formatDateSA(je.entryDate)} · Ref: {je.reference} · {je.evidenceStatus}
                    </p>
                    <div className="space-y-0.5 rounded bg-muted/40 p-2 font-mono text-[11px]">
                      {je.lines.map((ln) => (
                        <div key={ln.id} className="flex justify-between gap-2">
                          <span>{accName(ln.accountId)}</span>
                          <span>
                            {ln.debitCents > 0 ? `DR ${formatZarCents(ln.debitCents)}` : `CR ${formatZarCents(ln.creditCents)}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}