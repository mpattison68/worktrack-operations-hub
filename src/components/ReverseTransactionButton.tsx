import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { AuthSession } from "@/lib/domain/types";
import type { FinancialReversal, FinancialReversalTargetType } from "@/lib/domain/increment-d-types";
import { reverseFinancialTransaction } from "@/lib/data/increment-d-repository";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ReverseTransactionButtonProps {
  session: AuthSession;
  targetType: FinancialReversalTargetType;
  targetId: string;
  label: string;
  reversal?: FinancialReversal | undefined;
}

export function ReverseTransactionButton({
  session,
  targetType,
  targetId,
  label,
  reversal,
}: ReverseTransactionButtonProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const mutation = useMutation({
    mutationFn: () => reverseFinancialTransaction(session, { targetType, targetId, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
      toast.success("Transaction reversed with balanced audit entry. Original record preserved.");
      setReason("");
      setOpen(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not reverse transaction."),
  });

  if (reversal) {
    return (
      <Badge variant="outline" className="bg-status-bad-bg text-status-bad" title={reversal.reason}>
        Reversed: {reversal.reason}
      </Badge>
    );
  }

  if (session.role !== "admin") return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-9 gap-1 text-xs text-destructive hover:text-destructive">
          <RotateCcw className="h-3.5 w-3.5" />
          Reverse
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse financial transaction</DialogTitle>
          <DialogDescription>
            The original record ({label}) is preserved in the audit trail. A balanced offsetting entry will update cash, receivables, allocations, and loan balances.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor={`rev-reason-${targetId}`}>Correction reason (required)</Label>
          <Input
            id={`rev-reason-${targetId}`}
            placeholder="e.g. Entered against wrong bank account or duplicate capture"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="touch-target"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            type="button"
            variant="destructive"
            disabled={mutation.isPending || reason.trim().length < 3}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Reversing..." : "Confirm reversal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}