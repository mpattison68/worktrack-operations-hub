import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import { updateWorkerRole } from "@/lib/data/repository";
import { formatDateSA, formatZarCents } from "@/lib/format";
import type { AuthSession, PayRule, WorkerRole, WorkerRoleType } from "@/lib/domain/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ROLE_TYPES: WorkerRoleType[] = [
  "road_worker",
  "supervisor",
  "driver",
  "cook",
  "admin",
  "owner",
  "other",
];

function formatOptionalHourly(cents: number | null): string {
  return cents === null ? "Not set" : `${formatZarCents(cents)} / hr`;
}

interface RoleMaintenanceDialogProps {
  role: WorkerRole | null;
  payRules: PayRule[];
  canEditRates: boolean;
  session: AuthSession;
  onClose: () => void;
  onSaved: () => void;
  onAddRule: (roleId: string) => void;
  onEditRule: (rule: PayRule) => void;
  onCloseRule: (ruleId: string) => void;
}

export function RoleMaintenanceDialog({
  role,
  payRules,
  canEditRates,
  session,
  onClose,
  onSaved,
  onAddRule,
  onEditRule,
  onCloseRule,
}: RoleMaintenanceDialogProps) {
  const [name, setName] = React.useState("");
  const [roleType, setRoleType] = React.useState<WorkerRoleType>("road_worker");
  const [sharesCrew, setSharesCrew] = React.useState(true);

  React.useEffect(() => {
    if (!role) return;
    setName(role.name);
    setRoleType(role.roleType);
    setSharesCrew(role.sharesCrewSchedule);
  }, [role]);

  const saveRoleMutation = useMutation({
    mutationFn: () =>
      updateWorkerRole(session, role!.id, {
        name,
        roleType,
        sharesCrewSchedule: sharesCrew,
      }),
    onSuccess: () => {
      onSaved();
      toast.success("Role settings saved.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update role."),
  });

  const sortedRules = React.useMemo(
    () => [...payRules].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
    [payRules],
  );

  return (
    <Dialog open={Boolean(role)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{role?.name ?? "Role settings"}</DialogTitle>
          <DialogDescription>
            {canEditRates
              ? "Maintain role settings and effective-dated ordinary and overtime pay rules."
              : "Read-only view of role settings and pay rules. Only Management / Admin can edit rates."}
          </DialogDescription>
        </DialogHeader>

        {role && (
          <div className="space-y-5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveRoleMutation.mutate();
              }}
              className="space-y-3 rounded-md border border-border p-3.5"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Role details
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="rm-name">Role display name</Label>
                  <Input
                    id="rm-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!canEditRates}
                    className="touch-target"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label>Role type</Label>
                  <Select
                    value={roleType}
                    onValueChange={(v) => setRoleType(v as WorkerRoleType)}
                    disabled={!canEditRates}
                  >
                    <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ROLE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="rm-crew"
                    checked={sharesCrew}
                    onCheckedChange={(v) => setSharesCrew(Boolean(v))}
                    disabled={!canEditRates}
                  />
                  <Label htmlFor="rm-crew">Shares road crew weekly schedule</Label>
                </div>
                {canEditRates && (
                  <Button type="submit" size="sm" disabled={saveRoleMutation.isPending} className="touch-target">
                    Save role
                  </Button>
                )}
              </div>
            </form>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Linked pay rules ({sortedRules.length})
                </p>
                {canEditRates && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onAddRule(role.id)}
                    className="touch-target gap-1.5"
                  >
                    <Plus className="h-4 w-4" />
                    {en.workers.addPayRule}
                  </Button>
                )}
              </div>

              {sortedRules.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  No pay rules configured for this role yet.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {sortedRules.map((pr) => (
                    <div key={pr.id} className="space-y-2 rounded-md border border-border p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-semibold tabular-money">
                          {formatZarCents(pr.baseRateCents)} / {pr.payBasis}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            pr.isConfirmed
                              ? "bg-status-ok-bg text-status-ok"
                              : "bg-status-warn-bg text-status-warn"
                          }
                        >
                          {pr.isConfirmed ? en.common.confirmed : en.common.unconfirmed}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground">
                        Effective {formatDateSA(pr.effectiveFrom)} to{" "}
                        {pr.effectiveTo ? formatDateSA(pr.effectiveTo) : "open"} ·{" "}
                        {pr.normalHoursPerDay}h/day, {pr.normalWorkdaysPerWeek}d/wk
                      </p>
                      <div className="grid grid-cols-2 gap-1.5 rounded bg-muted/40 p-2">
                        <span>
                          Weekday OT: <strong className="tabular-money">{formatOptionalHourly(pr.weekdayOtHourlyCents)}</strong>
                        </span>
                        <span>
                          Saturday: <strong className="tabular-money">{formatOptionalHourly(pr.saturdayRateCents)}</strong>
                        </span>
                        <span>
                          Sunday: <strong className="tabular-money">{formatOptionalHourly(pr.sundayRateCents)}</strong>
                        </span>
                        <span>
                          Public holiday: <strong className="tabular-money">{formatOptionalHourly(pr.publicHolidayRateCents)}</strong>
                        </span>
                      </div>
                      {pr.notes && <p className="text-muted-foreground">{pr.notes}</p>}
                      {canEditRates && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onEditRule(pr)}
                            className="h-9 gap-1.5 text-xs"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit rates
                          </Button>
                          {pr.effectiveTo === null && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => onCloseRule(pr.id)}
                              className="h-9 text-xs"
                            >
                              End-date today
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}