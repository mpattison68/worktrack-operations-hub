import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Banknote, CheckCircle2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { AuthSession, Job, Worker } from "@/lib/domain/types";
import type { PayrollRun } from "@/lib/domain/increment-c-types";
import type { FinanceBundle, PaymentMethod } from "@/lib/domain/increment-d-types";
import { recordBulkWagePayment, updateWagePaymentEvidenceStatus } from "@/lib/data/increment-d-repository";
import { formatDateSA, formatZarCents, parseZarToCents, todaySAST } from "@/lib/format";
import { can } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface WagePaymentsPanelProps {
  session: AuthSession;
  finance: FinanceBundle;
  workers: Worker[];
  jobs: Job[];
  payrollRuns: PayrollRun[];
}

export function WagePaymentsPanel({
  session,
  finance,
  workers,
  jobs,
  payrollRuns,
}: WagePaymentsPanelProps) {
  const queryClient = useQueryClient();
  const activeWorkers = React.useMemo(() => workers.filter((w) => w.active), [workers]);
  const cashAccounts = React.useMemo(
    () => finance.accounts.filter((a) => a.isCashAccount && !a.isRestricted),
    [finance.accounts],
  );
  const approvedRuns = React.useMemo(
    () => payrollRuns.filter((r) => r.status === "approved"),
    [payrollRuns],
  );

  const [selectedIds, setSelectedIds] = React.useState<Record<string, boolean>>({});
  const [commonAmountRand, setCommonAmountRand] = React.useState("");
  const [customAmounts, setCustomAmounts] = React.useState<Record<string, string>>({});
  const [paymentDate, setPaymentDate] = React.useState(todaySAST());
  const [accountId, setAccountId] = React.useState(cashAccounts[0]?.id ?? "");
  const [jobId, setJobId] = React.useState<string>("none");
  const [method, setMethod] = React.useState<PaymentMethod>("cash");
  const [reference, setReference] = React.useState("");
  const [evidenceNote, setEvidenceNote] = React.useState("");

  React.useEffect(() => {
    if (!accountId && cashAccounts[0]?.id) setAccountId(cashAccounts[0].id);
  }, [accountId, cashAccounts]);

  const toggleWorker = (id: string, checked: boolean) => {
    setSelectedIds((prev) => ({ ...prev, [id]: checked }));
  };

  const selectAll = () => {
    const next: Record<string, boolean> = {};
    for (const w of activeWorkers) next[w.id] = true;
    setSelectedIds(next);
  };

  const previewLines = React.useMemo(() => {
    const lines: Array<{ workerId: string; name: string; amountCents: number }> = [];
    for (const w of activeWorkers) {
      if (!selectedIds[w.id]) continue;
      const raw = customAmounts[w.id]?.trim() ? customAmounts[w.id]! : commonAmountRand;
      const cents = parseZarToCents(raw);
      if (cents !== null && cents > 0) {
        lines.push({ workerId: w.id, name: w.fullName, amountCents: cents });
      }
    }
    return lines;
  }, [activeWorkers, selectedIds, customAmounts, commonAmountRand]);

  const previewTotalCents = previewLines.reduce((sum, l) => sum + l.amountCents, 0);

  const payMutation = useMutation({
    mutationFn: () =>
      recordBulkWagePayment(session, {
        jobId: jobId === "none" ? null : jobId,
        paymentDate,
        accountId,
        method,
        reference,
        evidenceNote,
        workerAmounts: previewLines.map((l) => ({ workerId: l.workerId, amountCents: l.amountCents })),
        approvedRuns,
      }),
    onSuccess: (payment) => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
      toast.success(`Wage payment of ${formatZarCents(payment.totalAmountCents)} posted to ledger.`);
      setSelectedIds({});
      setCustomAmounts({});
      setCommonAmountRand("");
      setReference("");
      setEvidenceNote("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record wage payment."),
  });

  const verifyMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "verified" | "disputed" }) =>
      updateWagePaymentEvidenceStatus(session, id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Payment evidence status updated.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update status."),
  });

  const canRecord = can(session.role, "payroll.record_payment");
  const canVerify = can(session.role, "payroll.reconcile");
  const workerName = (id: string) => workers.find((w) => w.id === id)?.fullName ?? "Worker";

  return (
    <div className="space-y-4">
      {canRecord && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-4 w-4 text-primary" />
              Bulk wage payment capture
            </CardTitle>
            <CardDescription className="text-xs">
              Allocates to oldest unpaid approved payroll week first; any remainder becomes a worker advance. Creates one balanced cash posting — never a duplicate expense.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                payMutation.mutate();
              }}
              className="space-y-4"
            >
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label htmlFor="wp-date">Payment date</Label>
                  <Input id="wp-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="touch-target" required />
                </div>
                <div className="space-y-1">
                  <Label>Paid from account</Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger className="touch-target"><SelectValue placeholder="Account" /></SelectTrigger>
                    <SelectContent>
                      {cashAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Method</Label>
                  <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="bank_transfer">Bank transfer / EFT</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Job (optional)</Label>
                  <Select value={jobId} onValueChange={setJobId}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">General / multi-job</SelectItem>
                      {jobs.map((j) => (
                        <SelectItem key={j.id} value={j.id}>{j.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="wp-common">Common amount per selected worker (ZAR)</Label>
                  <Input
                    id="wp-common"
                    inputMode="decimal"
                    placeholder="e.g. 760.00"
                    value={commonAmountRand}
                    onChange={(e) => setCommonAmountRand(e.target.value)}
                    className="touch-target tabular-money"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wp-ref">Reference / pay sheet no.</Label>
                  <Input id="wp-ref" placeholder="e.g. WAGES-WK48" value={reference} onChange={(e) => setReference(e.target.value)} className="touch-target" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wp-note">Signed receipt / note</Label>
                  <Input id="wp-note" placeholder="Signed cash register" value={evidenceNote} onChange={(e) => setEvidenceNote(e.target.value)} className="touch-target" />
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Select workers &amp; exception amounts
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={selectAll} className="h-9 text-xs">
                    Select all active ({activeWorkers.length})
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {activeWorkers.map((w) => (
                    <div key={w.id} className="flex items-center justify-between gap-2 rounded border border-border/70 bg-muted/20 px-2.5 py-2">
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                        <Checkbox
                          checked={Boolean(selectedIds[w.id])}
                          onCheckedChange={(v) => toggleWorker(w.id, Boolean(v))}
                        />
                        <span>{w.fullName}</span>
                      </label>
                      <Input
                        inputMode="decimal"
                        placeholder={commonAmountRand || "ZAR"}
                        value={customAmounts[w.id] ?? ""}
                        onChange={(e) => setCustomAmounts((p) => ({ ...p, [w.id]: e.target.value }))}
                        className="h-9 w-28 text-right text-xs tabular-money"
                        aria-label={`Amount for ${w.fullName}`}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
                <span>
                  Preview total ({previewLines.length} worker{previewLines.length === 1 ? "" : "s"}):{" "}
                  <strong className="tabular-money">{formatZarCents(previewTotalCents)}</strong>
                </span>
                <Button type="submit" disabled={payMutation.isPending || previewTotalCents <= 0} className="touch-target">
                  Confirm &amp; post wage payment
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recorded wage payments ({finance.wagePayments.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {finance.wagePayments.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No wage payments recorded yet.</p>
          ) : (
            finance.wagePayments.map((p) => (
              <div key={p.id} className="space-y-2 rounded-md border border-border p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold tabular-money">
                      {formatZarCents(p.totalAmountCents)} · {formatDateSA(p.paymentDate)}
                    </p>
                    <p className="text-muted-foreground">
                      {p.method.replace(/_/g, " ")} · Ref: {p.reference || "—"} · Recorded by {p.recordedBy}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        p.evidenceStatus === "verified"
                          ? "bg-status-ok-bg text-status-ok"
                          : p.evidenceStatus === "disputed"
                            ? "bg-status-bad-bg text-status-bad"
                            : "bg-status-warn-bg text-status-warn"
                      }
                    >
                      {p.evidenceStatus}
                    </Badge>
                    {canVerify && p.evidenceStatus !== "verified" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => verifyMutation.mutate({ id: p.id, status: "verified" })}
                        className="h-9 gap-1 text-xs"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Verify
                      </Button>
                    )}
                    {canVerify && p.evidenceStatus !== "disputed" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => verifyMutation.mutate({ id: p.id, status: "disputed" })}
                        className="h-9 gap-1 text-xs"
                      >
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Dispute
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {p.allocations.map((a) => (
                    <Badge key={a.id} variant="secondary" className="text-[11px] font-normal">
                      {workerName(a.workerId)}: {formatZarCents(a.amountCents)}
                      {a.payrollRunId ? " (allocated)" : " (advance)"}
                    </Badge>
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}