import { FinanceMaintenancePanel } from "@/components/FinanceMaintenancePanel";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2, Download, FileSpreadsheet, Landmark, Printer, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { AuthSession } from "@/lib/domain/types";
import type { FinanceBundle, LoanEventType } from "@/lib/domain/increment-d-types";
import {
  addLoanRepaymentSchedule,
  recordLoanEvent,
  recordRestrictedGrantReceipt,
  setLoanOpeningVerified,
} from "@/lib/data/increment-d-repository";
import {
  buildLoanStatement,
  calculateLoanBalanceCents,
  computeCashSummary,
  evaluateLoanRepaymentSchedule,
} from "@/lib/domain/finance-calc";
import {
  buildPrintableReportHtml,
  buildSafeCsv,
  buildSpreadsheetXml,
  type ExportMetadata,
} from "@/lib/domain/increment-e-calc";
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

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function LoansPanel({ session, finance }: LoansPanelProps) {
  const queryClient = useQueryClient();
  const [selectedLoanId, setSelectedLoanId] = React.useState(finance.loans[0]?.id ?? "");
  const [showNewLoan, setShowNewLoan] = React.useState(false);
  const loan = finance.loans.find((l) => l.id === selectedLoanId) ?? finance.loans[0] ?? null;

  React.useEffect(() => {
    if (!selectedLoanId && finance.loans[0]?.id) setSelectedLoanId(finance.loans[0].id);
  }, [selectedLoanId, finance.loans]);

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

  const [schedDate, setSchedDate] = React.useState(todaySAST());
  const [schedAmountRand, setSchedAmountRand] = React.useState("");
  const [schedRef, setSchedRef] = React.useState("");
  const [schedNote, setSchedNote] = React.useState("");

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

  const scheduleMutation = useMutation({
    mutationFn: () => {
      if (!loan) throw new Error("No loan account selected.");
      const cents = parseZarToCents(schedAmountRand);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR planned repayment amount.");
      return addLoanRepaymentSchedule(session, {
        loanId: loan.id,
        expectedDate: schedDate,
        expectedAmountCents: cents,
        reference: schedRef,
        note: schedNote,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Agreed repayment installment added to schedule and cash flow forecast.");
      setSchedAmountRand("");
      setSchedRef("");
      setSchedNote("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save planned repayment."),
  });

  if (!loan) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6 text-sm text-muted-foreground">
          <p>No loan account configured for this business. All opening balances are R 0.00 until manually established.</p>
          <FinanceMaintenancePanel session={session} finance={finance} kind="loan" />
        </CardContent>
      </Card>
    );
  }

  const summary = calculateLoanBalanceCents(loan, finance.loanEvents);
  const statement = buildLoanStatement(loan, finance.loanEvents);
  const scheduleEval = evaluateLoanRepaymentSchedule(
    loan,
    finance.loanEvents,
    finance.loanRepaymentSchedules ?? [],
    todaySAST(),
  );

  const buildStatementExport = () => {
    const metadata: ExportMetadata = {
      title: `Zero-Interest Loan Statement — ${loan.lenderName}`,
      businessName: session.businessName,
      dateRange: `Effective ${formatDateSA(statement.effectiveDate)} to ${formatDateSA(todaySAST())}`,
      revision: loan.reference || "R0 interest",
      status: summary.remainingPrincipalCents === 0 ? "Settled" : "Active",
      sourceIds: statement.rows.map((r) => r.id),
      generatedAt: new Date().toISOString(),
    };
    const headers = ["Date", "Type", "Reference", "Description", "Advance (ZAR)", "Repayment (ZAR)", "Running Balance (ZAR)", "Status"];
    const rows = statement.rows.map((r) => [
      formatDateSA(r.date),
      r.type,
      r.reference,
      r.description,
      r.advanceCents > 0 ? formatZarCents(r.advanceCents) : "",
      r.repaymentCents > 0 ? formatZarCents(r.repaymentCents) : "",
      formatZarCents(r.runningBalanceCents),
      r.evidenceStatus,
    ]);
    return { metadata, headers, rows };
  };

  const handleExportCsv = () => {
    const { metadata, headers, rows } = buildStatementExport();
    triggerDownload(buildSafeCsv(metadata, headers, rows), `loan-statement-${todaySAST()}.csv`, "text/csv;charset=utf-8");
    toast.success("Loan statement CSV downloaded.");
  };

  const handleExportExcel = () => {
    const { metadata, headers, rows } = buildStatementExport();
    triggerDownload(buildSpreadsheetXml(metadata, headers, rows), `loan-statement-${todaySAST()}.xls`, "application/vnd.ms-excel");
    toast.success("Loan statement Excel file downloaded.");
  };

  const handlePrintStatement = () => {
    const { metadata, headers, rows } = buildStatementExport();
    const html = buildPrintableReportHtml(metadata, headers, rows);
    const w = window.open("", "_blank", "noopener,noreferrer");
    if (!w) {
      toast.error("Allow pop-ups to print the loan statement.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div className="space-y-4">
      {(finance.loans.length > 1 || canEditLoans) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {finance.loans.length > 1 ? (
            <Select value={loan.id} onValueChange={setSelectedLoanId}>
              <SelectTrigger className="touch-target w-72"><SelectValue /></SelectTrigger>
              <SelectContent>
                {finance.loans.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.lenderName} {l.reference ? `(${l.reference})` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : <div />}
          {canEditLoans && (
            <Button variant="outline" size="sm" onClick={() => setShowNewLoan((v) => !v)}>
              {showNewLoan ? "Hide new loan form" : "Add another loan account"}
            </Button>
          )}
        </div>
      )}
      {showNewLoan && canEditLoans && <FinanceMaintenancePanel session={session} finance={finance} kind="loan" />}

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
          <CardDescription className="text-xs">
            Effective {formatDateSA(statement.effectiveDate)}
            {loan.reference ? ` · Ref: ${loan.reference}` : ""}
            {loan.repaymentTermsNote ? ` · ${loan.repaymentTermsNote}` : ""}
          </CardDescription>
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
            <span className="text-muted-foreground">
              {loan.notes ? `${loan.notes} · ` : ""}
              {loan.securityAssetNote ? `Security note: ${loan.securityAssetNote}` : "Opening loan liability does not increase cash or affect job profitability."}
            </span>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="h-4 w-4 text-primary" />
                Agreed repayment schedule ({scheduleEval.items.length})
              </CardTitle>
              <CardDescription className="text-xs">
                Optional planned repayments flow into the cash flow forecast without being treated as operating expenses.
              </CardDescription>
            </div>
            {scheduleEval.overdueCount > 0 && (
              <Badge variant="outline" className="gap-1 bg-status-bad-bg text-status-bad">
                <AlertTriangle className="h-3 w-3" />
                {scheduleEval.overdueCount} overdue ({formatZarCents(scheduleEval.totalOverdueCents)})
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {scheduleEval.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">No agreed repayment dates scheduled yet.</p>
          ) : (
            <div className="space-y-2">
              {scheduleEval.items.map(({ schedule, paidAmountCents, outstandingAmountCents, status }) => (
                <div key={schedule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-xs">
                  <div>
                    <p className="text-sm font-semibold tabular-money">
                      {formatZarCents(schedule.expectedAmountCents)} · Due {formatDateSA(schedule.expectedDate)}
                    </p>
                    <p className="text-muted-foreground">
                      Paid: <strong className="tabular-money">{formatZarCents(paidAmountCents)}</strong> · Outstanding:{" "}
                      <strong className="tabular-money">{formatZarCents(outstandingAmountCents)}</strong>
                      {schedule.reference ? ` · Ref: ${schedule.reference}` : ""}
                      {schedule.note ? ` · ${schedule.note}` : ""}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      status === "overdue"
                        ? "bg-status-bad-bg text-status-bad"
                        : status === "due"
                          ? "bg-status-warn-bg text-status-warn"
                          : status === "paid"
                            ? "bg-status-ok-bg text-status-ok"
                            : ""
                    }
                  >
                    {status === "overdue" ? "Overdue" : status === "due" ? "Due today" : status === "paid" ? "Paid" : "Upcoming"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
          {canEditLoans && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                scheduleMutation.mutate();
              }}
              className="grid gap-3 border-t border-border pt-3 sm:grid-cols-5"
            >
              <Input inputMode="decimal" placeholder="Planned ZAR" value={schedAmountRand} onChange={(e) => setSchedAmountRand(e.target.value)} className="touch-target tabular-money" required />
              <Input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} className="touch-target" required />
              <Input placeholder="Reference" value={schedRef} onChange={(e) => setSchedRef(e.target.value)} className="touch-target" />
              <Input placeholder="Optional note" value={schedNote} onChange={(e) => setSchedNote(e.target.value)} className="touch-target" />
              <Button type="submit" variant="outline" disabled={scheduleMutation.isPending} className="touch-target">
                Add planned repayment
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Loan statement &amp; transaction history ({statement.rows.length - 1} events)</CardTitle>
              <CardDescription className="text-xs">
                Chronological ledger of opening balance, advances, repayments, and running principal balance.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={handleExportCsv} className="gap-1.5 text-xs">
                <Download className="h-3.5 w-3.5" /> CSV
              </Button>
              <Button size="sm" variant="outline" onClick={handleExportExcel} className="gap-1.5 text-xs">
                <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
              </Button>
              <Button size="sm" variant="outline" onClick={handlePrintStatement} className="gap-1.5 text-xs">
                <Printer className="h-3.5 w-3.5" /> Print statement
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Reference</th>
                  <th className="py-2 pr-3">Description</th>
                  <th className="py-2 pr-3 text-right">Advance</th>
                  <th className="py-2 pr-3 text-right">Repayment</th>
                  <th className="py-2 text-right">Running balance</th>
                </tr>
              </thead>
              <tbody>
                {statement.rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDateSA(row.date)}</td>
                    <td className="py-2 pr-3 capitalize">{row.type.replace(/_/g, " ")}</td>
                    <td className="py-2 pr-3">{row.reference}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{row.description}</td>
                    <td className="py-2 pr-3 text-right tabular-money">{row.advanceCents > 0 ? `+ ${formatZarCents(row.advanceCents)}` : "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-money">{row.repaymentCents > 0 ? `- ${formatZarCents(row.repaymentCents)}` : "—"}</td>
                    <td className="py-2 text-right font-semibold tabular-money">{formatZarCents(row.runningBalanceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}