import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Banknote,
  Camera,
  Check,
  Fuel,
  HardHat,
  Package,
  Receipt,
  Truck,
  Utensils,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import type { AuthSession, Job } from "@/lib/domain/types";
import type {
  ExpenseCategory,
  ExpenseClassification,
  ExpensePaymentStatus,
  FinanceBundle,
  PaymentMethod,
  ReceiptAttachmentMeta,
} from "@/lib/domain/increment-d-types";
import {
  createExpenseRequest,
  recordExpense,
  reviewExpenseRequest,
} from "@/lib/data/increment-d-repository";
import { calculateFuelUnitCostCents } from "@/lib/domain/finance-calc";
import { formatDateSA, formatZarCents, parseZarToCents, todaySAST } from "@/lib/format";
import { can } from "@/lib/permissions";
import { useOfflineSync } from "@/lib/offline/sync-context";
import { enqueueOfflineMutation } from "@/lib/offline/sync-engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const CATEGORIES: Array<{ id: ExpenseCategory; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "fuel", label: "Fuel", icon: Fuel },
  { id: "food_water", label: "Food / water", icon: Utensils },
  { id: "wages", label: "Wages (redirect)", icon: Banknote },
  { id: "equipment_purchase", label: "Equipment buy", icon: Wrench },
  { id: "equipment_hire", label: "Equipment hire", icon: Wrench },
  { id: "equipment_repair", label: "Equipment repair", icon: Wrench },
  { id: "vehicle_repair", label: "Vehicle repair", icon: Truck },
  { id: "vehicle_service", label: "Vehicle service", icon: Truck },
  { id: "vehicle_tyres", label: "Tyres", icon: Truck },
  { id: "supplies", label: "Supplies", icon: Package },
  { id: "safety", label: "Safety / PPE", icon: HardHat },
  { id: "other", label: "Other", icon: Receipt },
];

async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ExpensesPanelProps {
  session: AuthSession;
  finance: FinanceBundle;
  jobs: Job[];
}

export function ExpensesPanel({ session, finance, jobs }: ExpensesPanelProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { effectiveOnline, refreshOfflineState } = useOfflineSync();
  const cashAccounts = React.useMemo(
    () => finance.accounts.filter((a) => a.isCashAccount && !a.isRestricted),
    [finance.accounts],
  );

  const [category, setCategory] = React.useState<ExpenseCategory>("fuel");
  const [amountRand, setAmountRand] = React.useState("");
  const [expenseDate, setExpenseDate] = React.useState(todaySAST());
  const [jobId, setJobId] = React.useState<string>(jobs[0]?.id ?? "overhead");
  const [classification, setClassification] = React.useState<ExpenseClassification>("operating");
  const [paymentStatus, setPaymentStatus] = React.useState<ExpensePaymentStatus>("paid");
  const [paidRand, setPaidRand] = React.useState("");
  const [accountId, setAccountId] = React.useState(cashAccounts[0]?.id ?? "");
  const [method, setMethod] = React.useState<PaymentMethod>("cash");
  const [supplier, setSupplier] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [fuelLitres, setFuelLitres] = React.useState("");
  const [vehicleOrMachine, setVehicleOrMachine] = React.useState("");
  const [odometerKm, setOdometerKm] = React.useState("");
  const [receipt, setReceipt] = React.useState<ReceiptAttachmentMeta | null>(null);
  const [missingReason, setMissingReason] = React.useState("");

  // Expense request state
  const [reqCategory, setReqCategory] = React.useState<ExpenseCategory>("equipment_repair");
  const [reqAmountRand, setReqAmountRand] = React.useState("");
  const [reqDesc, setReqDesc] = React.useState("");

  React.useEffect(() => {
    if (!accountId && cashAccounts[0]?.id) setAccountId(cashAccounts[0].id);
  }, [accountId, cashAccounts]);

  const handleCategoryPick = (cat: ExpenseCategory) => {
    if (cat === "wages") {
      toast.info(en.finance.wagesRedirectNotice);
      navigate({ to: "/money" });
      return;
    }
    setCategory(cat);
    if (cat === "equipment_purchase") setClassification("capital");
  };

  const handleReceiptFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const checksumSha256 = await computeSha256Hex(buf);
    setReceipt({
      fileName: file.name,
      mimeType: file.type || "image/jpeg",
      sizeBytes: file.size,
      checksumSha256,
      capturedAt: new Date().toISOString(),
    });
    setMissingReason("");
    toast.success(`Receipt attached (${file.name}).`);
  };

  const parsedAmount = parseZarToCents(amountRand);
  const parsedLitres = fuelLitres.trim() ? Number(fuelLitres) : null;
  const unitCostCents =
    category === "fuel" && parsedAmount && parsedLitres
      ? calculateFuelUnitCostCents(parsedAmount, parsedLitres)
      : null;

  const saveExpenseMutation = useMutation({
    mutationFn: async () => {
      if (parsedAmount === null || parsedAmount <= 0) {
        throw new Error("Enter a positive ZAR expense amount.");
      }
      const paidAmountCents =
        paymentStatus === "paid"
          ? parsedAmount
          : paymentStatus === "unpaid_payable"
            ? 0
            : parseZarToCents(paidRand) ?? 0;
      const payload = {
        jobId: jobId === "overhead" ? null : jobId,
        expenseDate,
        category,
        classification,
        amountCents: parsedAmount,
        paidAmountCents,
        paymentStatus,
        accountId: accountId || null,
        method,
        supplierName: supplier,
        description,
        reference,
        fuelLitres: category === "fuel" && parsedLitres && parsedLitres > 0 ? parsedLitres : null,
        vehicleOrMachine: category === "fuel" ? vehicleOrMachine : "",
        odometerKm: category === "fuel" && odometerKm.trim() ? Number(odometerKm) : null,
        receiptAttachment: receipt,
        missingReceiptReason: receipt ? null : missingReason,
      };
      if (!effectiveOnline) {
        if (!payload.receiptAttachment && !payload.missingReceiptReason?.trim()) {
          throw new Error("Attach a receipt photo or enter a missing-receipt reason.");
        }
        await enqueueOfflineMutation(session, {
          entityType: "expense",
          operation: "create",
          label: `Expense: ${category.replace(/_/g, " ")} (${formatZarCents(parsedAmount)})`,
          payload,
        });
        await refreshOfflineState();
        return { queuedOffline: true as const };
      }
      const exp = await recordExpense(session, payload);
      return { queuedOffline: false as const, exp };
    },
    onSuccess: (result) => {
      if (result.queuedOffline) {
        toast.info("Saved on phone — pending sync. Will upload when connection returns.");
      } else {
        queryClient.invalidateQueries({ queryKey: ["finance"] });
        toast.success(
          result.exp.needsReview
            ? "Expense saved and flagged for review (missing receipt or duplicate)."
            : "Expense saved and posted to cash ledger.",
        );
      }
      setAmountRand("");
      setPaidRand("");
      setSupplier("");
      setDescription("");
      setReference("");
      setFuelLitres("");
      setVehicleOrMachine("");
      setOdometerKm("");
      setReceipt(null);
      setMissingReason("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record expense."),
  });

  const requestMutation = useMutation({
    mutationFn: () => {
      const cents = parseZarToCents(reqAmountRand);
      if (cents === null || cents <= 0) throw new Error("Enter a positive ZAR estimate.");
      return createExpenseRequest(session, {
        jobId: jobId === "overhead" ? null : jobId,
        category: reqCategory,
        estimatedAmountCents: cents,
        description: reqDesc,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Expense request submitted for Admin approval.");
      setReqAmountRand("");
      setReqDesc("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not submit request."),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "declined" }) =>
      reviewExpenseRequest(session, id, decision, ""),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Expense request updated.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not review request."),
  });

  const canApproveRequests = can(session.role, "payroll.reconcile");
  const jobName = (id: string | null) =>
    id ? (jobs.find((j) => j.id === id)?.name ?? "Job") : "Business overhead";

  return (
    <Tabs defaultValue="capture" className="space-y-4">
      <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-flex">
        <TabsTrigger value="capture" className="touch-target">Capture &amp; log ({finance.expenses.length})</TabsTrigger>
        <TabsTrigger value="requests" className="touch-target">Pre-purchase requests ({finance.expenseRequests.length})</TabsTrigger>
      </TabsList>

      <TabsContent value="capture" className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Capture expense</CardTitle>
            <CardDescription className="text-xs">
              Tap a category, enter ZAR amount, and attach a receipt photo or missing-receipt reason.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveExpenseMutation.mutate();
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {CATEGORIES.map((c) => {
                  const Icon = c.icon;
                  const active = category === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => handleCategoryPick(c.id)}
                      className={`touch-target flex flex-col items-center justify-center gap-1 rounded-md border p-2 text-center text-xs transition-colors ${
                        active
                          ? "border-primary bg-primary/10 font-semibold text-primary"
                          : "border-border bg-card text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="leading-tight">{c.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label htmlFor="exp-amt">Amount (ZAR)</Label>
                  <Input id="exp-amt" inputMode="decimal" value={amountRand} onChange={(e) => setAmountRand(e.target.value)} className="touch-target tabular-money" required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="exp-date">Date</Label>
                  <Input id="exp-date" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} className="touch-target" required />
                </div>
                <div className="space-y-1">
                  <Label>Job / overhead</Label>
                  <Select value={jobId} onValueChange={setJobId}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {session.role !== "supervisor" && <SelectItem value="overhead">Business overhead</SelectItem>}
                      {jobs.map((j) => (
                        <SelectItem key={j.id} value={j.id}>{j.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Classification</Label>
                  <Select value={classification} onValueChange={(v) => setClassification(v as ExpenseClassification)}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="operating">Operating expense</SelectItem>
                      <SelectItem value="capital">Capital expenditure</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label>Payment status</Label>
                  <Select value={paymentStatus} onValueChange={(v) => setPaymentStatus(v as ExpensePaymentStatus)}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="paid">Paid now</SelectItem>
                      <SelectItem value="unpaid_payable">Unpaid (supplier payable)</SelectItem>
                      <SelectItem value="partially_paid">Partially paid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {paymentStatus === "partially_paid" && (
                  <div className="space-y-1">
                    <Label htmlFor="exp-paid">Paid now (ZAR)</Label>
                    <Input id="exp-paid" inputMode="decimal" value={paidRand} onChange={(e) => setPaidRand(e.target.value)} className="touch-target tabular-money" />
                  </div>
                )}
                {cashAccounts.length > 0 && paymentStatus !== "unpaid_payable" && (
                  <div className="space-y-1">
                    <Label>Cash / bank account</Label>
                    <Select value={accountId} onValueChange={setAccountId}>
                      <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {cashAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label>Method</Label>
                  <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="exp-sup">Supplier (optional)</Label>
                  <Input id="exp-sup" value={supplier} onChange={(e) => setSupplier(e.target.value)} className="touch-target" />
                </div>
              </div>

              {category === "fuel" && (
                <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="exp-litres">Litres (optional)</Label>
                    <Input id="exp-litres" type="number" step="0.1" value={fuelLitres} onChange={(e) => setFuelLitres(e.target.value)} className="touch-target" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="exp-veh">Vehicle / machine</Label>
                    <Input id="exp-veh" placeholder="e.g. 4-ton crew truck" value={vehicleOrMachine} onChange={(e) => setVehicleOrMachine(e.target.value)} className="touch-target" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="exp-odo">Odometer (km)</Label>
                    <Input id="exp-odo" type="number" value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} className="touch-target" />
                  </div>
                  {unitCostCents !== null && (
                    <p className="text-xs text-muted-foreground sm:col-span-3">
                      Calculated fuel unit cost: <strong className="tabular-money">{formatZarCents(unitCostCents)} / L</strong>
                    </p>
                  )}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="exp-desc">
                    Short description {category === "other" ? "(required)" : "(optional)"}
                  </Label>
                  <Input id="exp-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="touch-target" required={category === "other"} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="exp-ref">Receipt / invoice reference</Label>
                  <Input id="exp-ref" value={reference} onChange={(e) => setReference(e.target.value)} className="touch-target" />
                </div>
              </div>

              <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="exp-file" className="flex items-center gap-1.5">
                    <Camera className="h-4 w-4" />
                    Receipt photo / PDF
                  </Label>
                  <Input id="exp-file" type="file" accept="image/*,.pdf" onChange={handleReceiptFile} className="touch-target" />
                  {receipt && (
                    <p className="text-[11px] text-status-ok">
                      Attached: {receipt.fileName} (SHA-256 {receipt.checksumSha256.slice(0, 10)}…)
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="exp-miss">Missing-receipt reason (required if no photo)</Label>
                  <Input
                    id="exp-miss"
                    placeholder="e.g. Second-hand seller cash sale, no till slip"
                    value={missingReason}
                    onChange={(e) => setMissingReason(e.target.value)}
                    disabled={Boolean(receipt)}
                    className="touch-target"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <Button type="submit" disabled={saveExpenseMutation.isPending} className="touch-target">
                  Save expense
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent expenses ({finance.expenses.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {finance.expenses.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No expenses recorded yet.</p>
            ) : (
              finance.expenses.map((exp) => (
                <div key={exp.id} className="space-y-1 rounded-md border border-border p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold tabular-money">
                      {formatZarCents(exp.amountCents)} · {exp.category.replace(/_/g, " ")}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">{exp.classification}</Badge>
                      <Badge variant="secondary">{exp.paymentStatus.replace(/_/g, " ")}</Badge>
                      {exp.needsReview && (
                        <Badge variant="outline" className="gap-1 bg-status-warn-bg text-status-warn">
                          <AlertTriangle className="h-3 w-3" />
                          Review needed
                        </Badge>
                      )}
                    </div>
                  </div>
                  <p className="text-muted-foreground">
                    {formatDateSA(exp.expenseDate)} · {jobName(exp.jobId)} · Paid {formatZarCents(exp.paidAmountCents)}
                    {exp.supplierName ? ` · ${exp.supplierName}` : ""}
                  </p>
                  {exp.description && <p>{exp.description}</p>}
                  {exp.missingReceiptReason && (
                    <p className="text-status-warn">Missing receipt: {exp.missingReceiptReason}</p>
                  )}
                  {exp.duplicateWarningFlag && (
                    <p className="text-status-warn">Duplicate warning: same date &amp; amount already exists.</p>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="requests" className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Request pre-purchase approval</CardTitle>
            <CardDescription className="text-xs">
              Optional pre-approval for larger purchases; actual expenses can still be recorded with an exception flag.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                requestMutation.mutate();
              }}
              className="grid gap-3 sm:grid-cols-4"
            >
              <Select value={reqCategory} onValueChange={(v) => setReqCategory(v as ExpenseCategory)}>
                <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.filter((c) => c.id !== "wages").map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input inputMode="decimal" placeholder="Estimated ZAR" value={reqAmountRand} onChange={(e) => setReqAmountRand(e.target.value)} className="touch-target tabular-money" required />
              <Input placeholder="What is needed?" value={reqDesc} onChange={(e) => setReqDesc(e.target.value)} className="touch-target" required />
              <Button type="submit" disabled={requestMutation.isPending} className="touch-target">Submit request</Button>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-2">
          {finance.expenseRequests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card p-3 text-xs">
              <div>
                <p className="font-semibold">
                  {r.category.replace(/_/g, " ")} — <span className="tabular-money">{formatZarCents(r.estimatedAmountCents)}</span>
                </p>
                <p className="text-muted-foreground">{r.description} · By {r.requestedBy}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{r.status}</Badge>
                {canApproveRequests && r.status === "pending" && (
                  <>
                    <Button size="sm" onClick={() => reviewMutation.mutate({ id: r.id, decision: "approved" })} className="h-9 gap-1">
                      <Check className="h-3.5 w-3.5" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: r.id, decision: "declined" })} className="h-9 gap-1">
                      <X className="h-3.5 w-3.5" /> Decline
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}