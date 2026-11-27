import type { PayRule } from "@/lib/domain/types";

/**
 * Check whether two inclusive YYYY-MM-DD date ranges [startA, endA] and [startB, endB]
 * overlap. A null end date represents an open-ended range (+infinity).
 */
export function dateRangesOverlap(
  startA: string,
  endA: string | null,
  startB: string,
  endB: string | null,
): boolean {
  const aEndsBeforeB = endA !== null && endA < startB;
  const bEndsBeforeA = endB !== null && endB < startA;
  return !aEndsBeforeB && !bEndsBeforeA;
}

/**
 * Validate a candidate pay rule against existing rules for the same worker_role_id.
 * Enforces Section 16: date-effective wage rules with no overlapping effective ranges.
 */
export function validatePayRuleCandidate(
  candidate: {
    id?: string;
    workerRoleId: string;
    baseRateCents: number;
    normalHoursPerDay: number;
    normalWorkdaysPerWeek: number;
    weekdayOtHourlyCents?: number | null;
    saturdayRateCents?: number | null;
    sundayRateCents?: number | null;
    publicHolidayRateCents?: number | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  },
  existingRules: PayRule[],
): string | null {
  if (!candidate.workerRoleId) return "Select a worker role.";
  if (!Number.isInteger(candidate.baseRateCents) || candidate.baseRateCents <= 0) {
    return "Base rate must be a positive ZAR amount.";
  }
  const optionalRates: Array<[string, number | null | undefined]> = [
    ["Weekday OT hourly rate", candidate.weekdayOtHourlyCents],
    ["Saturday hourly rate", candidate.saturdayRateCents],
    ["Sunday hourly rate", candidate.sundayRateCents],
    ["Public holiday hourly rate", candidate.publicHolidayRateCents],
  ];
  for (const [label, cents] of optionalRates) {
    if (cents !== undefined && cents !== null && (!Number.isInteger(cents) || cents <= 0)) {
      return `${label} must be a positive ZAR amount or left blank.`;
    }
  }
  if (candidate.normalHoursPerDay <= 0 || candidate.normalHoursPerDay > 24) {
    return "Normal hours per day must be between 0.5 and 24.";
  }
  if (candidate.normalWorkdaysPerWeek < 1 || candidate.normalWorkdaysPerWeek > 7) {
    return "Normal workdays per week must be between 1 and 7.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.effectiveFrom)) {
    return "Enter a valid effective start date (YYYY-MM-DD).";
  }
  if (candidate.effectiveTo !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.effectiveTo)) {
      return "Enter a valid effective end date (YYYY-MM-DD).";
    }
    if (candidate.effectiveTo < candidate.effectiveFrom) {
      return "Effective end date cannot be before start date.";
    }
  }

  const sameRole = existingRules.filter(
    (r) => r.workerRoleId === candidate.workerRoleId && r.id !== candidate.id,
  );
  for (const rule of sameRole) {
    if (
      dateRangesOverlap(
        candidate.effectiveFrom,
        candidate.effectiveTo,
        rule.effectiveFrom,
        rule.effectiveTo,
      )
    ) {
      return `Effective dates overlap an existing rule (${rule.effectiveFrom} to ${rule.effectiveTo ?? "open"}). Close the previous rule before starting a new effective date.`;
    }
  }
  return null;
}

/**
 * Resolve the effective pay rule for a given worker role on a specific YYYY-MM-DD date.
 */
export function resolveEffectivePayRule(
  rules: PayRule[],
  workerRoleId: string,
  onDate: string,
): PayRule | null {
  return (
    rules.find(
      (r) =>
        r.workerRoleId === workerRoleId &&
        r.effectiveFrom <= onDate &&
        (r.effectiveTo === null || r.effectiveTo >= onDate),
    ) ?? null
  );
}

export function validateJobInput(input: {
  name: string;
  customerName: string;
  contractReference: string;
  contractValueCents: number;
  roadOrArea: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  openingCashAllocationCents: number;
}): string | null {
  if (!input.name.trim()) return "Job name is required.";
  if (!input.customerName.trim()) return "Customer name is required.";
  if (!input.roadOrArea.trim()) return "Road or area is required.";
  if (!Number.isInteger(input.contractValueCents) || input.contractValueCents < 0) {
    return "Contract value must be zero or a positive ZAR amount.";
  }
  if (
    !Number.isInteger(input.openingCashAllocationCents) ||
    input.openingCashAllocationCents < 0
  ) {
    return "Opening cash allocation must be zero or a positive ZAR amount.";
  }
  if (
    input.plannedStartDate &&
    input.plannedEndDate &&
    input.plannedEndDate < input.plannedStartDate
  ) {
    return "Planned end date cannot be before planned start date.";
  }
  return null;
}