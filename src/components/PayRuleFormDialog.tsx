import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import { createPayRule, updatePayRule } from "@/lib/data/repository";
import { parseZarToCents, todaySAST } from "@/lib/format";
import type { AuthSession, PayBasis, PayRule, WorkerRole } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function centsToInput(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function parseOptionalPositiveZar(raw: string, label: string): number | null {
  if (!raw.trim()) return null;
  const cents = parseZarToCents(raw);
  if (cents === null || cents <= 0) {
    throw new Error(`${label} must be a positive ZAR amount or left blank.`);
  }
  return cents;
}

interface PayRuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: AuthSession;
  roles: WorkerRole[];
  initialRoleId?: string;
  editingRule: PayRule | null;
  onSaved: () => void;
}

export function PayRuleFormDialog({
  open,
  onOpenChange,
  session,
  roles,
  initialRoleId,
  editingRule,
  onSaved,
}: PayRuleFormDialogProps) {
  const [roleId, setRoleId] = React.useState("");
  const [basis, setBasis] = React.useState<PayBasis>("daily");
  const [rateRand, setRateRand] = React.useState("");
  const [hours, setHours] = React.useState("9");
  const [days, setDays] = React.useState("5");
  const [weekdayOtRand, setWeekdayOtRand] = React.useState("");
  const [saturdayRand, setSaturdayRand] = React.useState("");
  const [sundayRand, setSundayRand] = React.useState("");
  const [publicHolidayRand, setPublicHolidayRand] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState(todaySAST());
  const [effectiveTo, setEffectiveTo] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    if (editingRule) {
      setRoleId(editingRule.workerRoleId);
      setBasis(editingRule.payBasis);
      setRateRand(centsToInput(editingRule.baseRateCents));
      setHours(String(editingRule.normalHoursPerDay));
      setDays(String(editingRule.normalWorkdaysPerWeek));
      setWeekdayOtRand(centsToInput(editingRule.weekdayOtHourlyCents));
      setSaturdayRand(centsToInput(editingRule.saturdayRateCents));
      setSundayRand(centsToInput(editingRule.sundayRateCents));
      setPublicHolidayRand(centsToInput(editingRule.publicHolidayRateCents));
      setEffectiveFrom(editingRule.effectiveFrom);
      setEffectiveTo(editingRule.effectiveTo ?? "");
      setConfirmed(editingRule.isConfirmed);
      setNotes(editingRule.notes);
    } else {
      setRoleId(initialRoleId || roles[0]?.id || "");
      setBasis("daily");
      setRateRand("");
      setHours("9");
      setDays("5");
      setWeekdayOtRand("");
      setSaturdayRand("");
      setSundayRand("");
      setPublicHolidayRand("");
      setEffectiveFrom(todaySAST());
      setEffectiveTo("");
      setConfirmed(false);
      setNotes("");
    }
  }, [open, editingRule, initialRoleId, roles]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const baseRateCents = parseZarToCents(rateRand);
      if (baseRateCents === null || baseRateCents <= 0) {
        throw new Error("Enter a positive ZAR base rate.");
      }
      const payload = {
        workerRoleId: roleId,
        payBasis: basis,
        baseRateCents,
        normalHoursPerDay: Number(hours),
        normalWorkdaysPerWeek: Number(days),
        weekdayOtHourlyCents: parseOptionalPositiveZar(weekdayOtRand, "Weekday OT hourly rate"),
        saturdayRateCents: parseOptionalPositiveZar(saturdayRand, "Saturday hourly rate"),
        sundayRateCents: parseOptionalPositiveZar(sundayRand, "Sunday hourly rate"),
        publicHolidayRateCents: parseOptionalPositiveZar(
          publicHolidayRand,
          "Public holiday hourly rate",
        ),
        weeklyProrationPolicy:
          basis === "weekly" ? ("full_week_entitlement" as const) : ("none" as const),
        effectiveFrom,
        effectiveTo: effectiveTo.trim() ? effectiveTo.trim() : null,
        isConfirmed: confirmed,
        notes,
      };
      if (editingRule) {
        return updatePayRule(session, editingRule.id, payload);
      }
      return createPayRule(session, payload);
    },
    onSuccess: () => {
      onSaved();
      toast.success(editingRule ? "Pay rule updated." : "Effective-dated pay rule added.");
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save pay rule."),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingRule ? en.workers.editPayRule : en.workers.addPayRule}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveMutation.mutate();
          }}
          className="space-y-3"
        >
          <div className="space-y-1">
            <Label>Worker role</Label>
            <Select value={roleId} onValueChange={setRoleId} disabled={Boolean(editingRule)}>
              <SelectTrigger className="touch-target">
                <SelectValue placeholder="Choose role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Pay basis</Label>
              <Select value={basis} onValueChange={(v) => setBasis(v as PayBasis)}>
                <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pr-rate">Base rate (ZAR)</Label>
              <Input
                id="pr-rate"
                inputMode="decimal"
                value={rateRand}
                onChange={(e) => setRateRand(e.target.value)}
                className="touch-target tabular-money"
                required
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pr-hrs">Normal hours / day</Label>
              <Input
                id="pr-hrs"
                type="number"
                step="0.5"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="touch-target"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pr-days">Normal days / week</Label>
              <Input
                id="pr-days"
                type="number"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="touch-target"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pr-from">Effective from</Label>
              <Input
                id="pr-from"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="touch-target"
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pr-to">Effective to (optional)</Label>
              <Input
                id="pr-to"
                type="date"
                value={effectiveTo}
                onChange={(e) => setEffectiveTo(e.target.value)}
                className="touch-target"
              />
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <div>
              <p className="text-xs font-semibold text-foreground">
                Overtime &amp; special-day hourly rates (ZAR / hr, optional)
              </p>
              <p className="text-xs text-muted-foreground">
                Leave blank if not yet agreed. Payroll will block approval if hours are logged for a blank class.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pr-ot-weekday">Weekday OT (ZAR / hr)</Label>
                <Input
                  id="pr-ot-weekday"
                  inputMode="decimal"
                  placeholder="e.g. 58.33"
                  value={weekdayOtRand}
                  onChange={(e) => setWeekdayOtRand(e.target.value)}
                  className="touch-target tabular-money"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-ot-sat">Saturday (ZAR / hr)</Label>
                <Input
                  id="pr-ot-sat"
                  inputMode="decimal"
                  placeholder="e.g. 58.33"
                  value={saturdayRand}
                  onChange={(e) => setSaturdayRand(e.target.value)}
                  className="touch-target tabular-money"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-ot-sun">Sunday (ZAR / hr)</Label>
                <Input
                  id="pr-ot-sun"
                  inputMode="decimal"
                  placeholder="e.g. 77.78"
                  value={sundayRand}
                  onChange={(e) => setSundayRand(e.target.value)}
                  className="touch-target tabular-money"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-ot-ph">Public holiday (ZAR / hr)</Label>
                <Input
                  id="pr-ot-ph"
                  inputMode="decimal"
                  placeholder="e.g. 77.78"
                  value={publicHolidayRand}
                  onChange={(e) => setPublicHolidayRand(e.target.value)}
                  className="touch-target tabular-money"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pr-notes">Notes (OT/weekend terms)</Label>
            <Input
              id="pr-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="touch-target"
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="pr-conf" checked={confirmed} onCheckedChange={(v) => setConfirmed(Boolean(v))} />
            <Label htmlFor="pr-conf">Admin-confirmed against SA employment terms</Label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="touch-target">
              {en.common.cancel}
            </Button>
            <Button type="submit" disabled={saveMutation.isPending} className="touch-target">
              {en.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}