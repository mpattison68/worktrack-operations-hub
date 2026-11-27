import {
  DIFFICULTY_FACTORS,
  type BudgetLineInput,
  type RoadSectionInput,
  type VergeSide,
} from "@/lib/domain/assessment-types";

export interface SizingSummary {
  roadLengthMeters: number;
  vergeLengthMeters: number;
  physicalAreaSqm: number;
  effortUnitsSqm: number;
  weightedDifficultyFactor: number;
  unknownWidthCount: number;
  requiredWorkerDays: number | null;
  plannedCrewDays: number | null;
  plannedWeeks: number | null;
  estimatedLabourCents: number;
  estimatedOtherOperatingCents: number;
  estimatedTotalOperatingCents: number;
  estimatedCapitalCents: number;
  estimatedOperatingSurplusCents: number;
  costPerRoadKmCents: number | null;
  costPerVergeKmCents: number | null;
  costPerSqmCents: number | null;
}

/**
 * Merge closed/half-open numeric intervals [start, end] and return total union length.
 * Used so road length is the union of road chainage intervals, never a sum across strips.
 */
export function mergeIntervalLength(intervals: Array<[number, number]>): number {
  const valid = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  if (valid.length === 0) return 0;
  let total = 0;
  let curStart = valid[0]![0];
  let curEnd = valid[0]![1];
  for (let i = 1; i < valid.length; i++) {
    const [s, e] = valid[i]!;
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return Math.round(total * 100) / 100;
}

/**
 * Validate section strip rules:
 * - Dual carriageway shared median cannot be combined with inner_a or inner_b (prevents double counting, T02).
 * - Single carriageway may only use left/right; dual carriageway uses outer_a/inner_a/inner_b/outer_b/shared_median.
 * - No duplicate strip side in the same section.
 * - Section chainage end must be > start; no overlapping chainage on the same strip across sections.
 */
export function validateAssessmentSections(sections: RoadSectionInput[]): string[] {
  const errors: string[] = [];
  if (sections.length === 0) {
    errors.push("Add at least one road section.");
    return errors;
  }

  const stripIntervals = new Map<VergeSide, Array<[number, number, string]>>();

  for (const sec of sections) {
    if (sec.endChainageMeters <= sec.startChainageMeters) {
      errors.push(`${sec.label}: end chainage must be greater than start chainage.`);
    }
    if (sec.strips.length === 0) {
      errors.push(`${sec.label}: select at least one verge strip.`);
    }

    const sides = new Set<VergeSide>();
    for (const strip of sec.strips) {
      if (sides.has(strip.side)) {
        errors.push(`${sec.label}: duplicate strip "${strip.side}" is not allowed.`);
      }
      sides.add(strip.side);

      if (sec.carriageway === "single" && strip.side !== "left" && strip.side !== "right") {
        errors.push(`${sec.label}: single carriageway only allows left or right verges.`);
      }
      if (sec.carriageway === "dual" && (strip.side === "left" || strip.side === "right")) {
        errors.push(`${sec.label}: dual carriageway must use outer/inner or shared median strips.`);
      }
      if (strip.widthMeters !== null && strip.widthMeters <= 0) {
        errors.push(`${sec.label} (${strip.side}): clearing width must be greater than 0 or left unknown.`);
      }
      if (strip.lengthOverrideMeters !== null && strip.lengthOverrideMeters <= 0) {
        errors.push(`${sec.label} (${strip.side}): length override must be positive.`);
      }

      const list = stripIntervals.get(strip.side) ?? [];
      for (const [prevS, prevE, prevLabel] of list) {
        if (sec.startChainageMeters < prevE && prevS < sec.endChainageMeters) {
          errors.push(
            `${sec.label} overlaps ${prevLabel} on strip "${strip.side}" (${sec.startChainageMeters}m–${sec.endChainageMeters}m).`,
          );
        }
      }
      list.push([sec.startChainageMeters, sec.endChainageMeters, sec.label]);
      stripIntervals.set(strip.side, list);
    }

    // T02 guard: shared median overlap rejection
    if (sides.has("shared_median") && (sides.has("inner_a") || sides.has("inner_b"))) {
      errors.push(
        `${sec.label}: shared median cannot be selected together with Inner A or Inner B (prevents double counting median area).`,
      );
    }
  }

  return errors;
}

/**
 * Deterministic Section 6 sizing, effort, crew-day, and integer-cent budget calculation.
 * Handles zero/unknown values safely without division by zero.
 */
export function calculateAssessmentSizing(params: {
  sections: RoadSectionInput[];
  benchmarkProductivitySqm: number;
  productiveCrewSize: number;
  roadWorkerDailyRateCents: number;
  cookWeeklyRateCents: number;
  includeCook: boolean;
  workdaysPerWeek: number;
  contractValueCents: number;
  budgetLines: BudgetLineInput[];
}): SizingSummary {
  const roadIntervals: Array<[number, number]> = params.sections.map((s) => [
    s.startChainageMeters,
    s.endChainageMeters,
  ]);
  const roadLengthMeters = mergeIntervalLength(roadIntervals);

  let vergeLengthMeters = 0;
  let physicalAreaSqm = 0;
  let effortUnitsSqm = 0;
  let unknownWidthCount = 0;

  for (const sec of params.sections) {
    const secLen = Math.max(0, sec.endChainageMeters - sec.startChainageMeters);
    const factor = DIFFICULTY_FACTORS[sec.difficulty].factor;
    for (const strip of sec.strips) {
      const stripLen = strip.lengthOverrideMeters ?? secLen;
      vergeLengthMeters += stripLen;
      if (strip.widthMeters === null) {
        unknownWidthCount += 1;
      } else {
        const area = stripLen * strip.widthMeters;
        physicalAreaSqm += area;
        effortUnitsSqm += area * factor;
      }
    }
  }

  vergeLengthMeters = Math.round(vergeLengthMeters * 100) / 100;
  physicalAreaSqm = Math.round(physicalAreaSqm * 100) / 100;
  effortUnitsSqm = Math.round(effortUnitsSqm * 100) / 100;

  const weightedDifficultyFactor =
    physicalAreaSqm > 0 ? Math.round((effortUnitsSqm / physicalAreaSqm) * 100) / 100 : 1;

  const requiredWorkerDays =
    params.benchmarkProductivitySqm > 0 && effortUnitsSqm > 0
      ? Math.round((effortUnitsSqm / params.benchmarkProductivitySqm) * 100) / 100
      : null;

  const plannedCrewDays =
    requiredWorkerDays !== null && params.productiveCrewSize > 0
      ? Math.ceil(requiredWorkerDays / params.productiveCrewSize)
      : null;

  const plannedWeeks =
    plannedCrewDays !== null && params.workdaysPerWeek > 0
      ? Math.ceil(plannedCrewDays / params.workdaysPerWeek)
      : null;

  const roadLabourCents =
    plannedCrewDays !== null
      ? Math.round(plannedCrewDays * params.productiveCrewSize * params.roadWorkerDailyRateCents)
      : 0;
  const cookLabourCents =
    params.includeCook && plannedWeeks !== null
      ? Math.round(plannedWeeks * params.cookWeeklyRateCents)
      : 0;
  const estimatedLabourCents = roadLabourCents + cookLabourCents;

  const estimatedOtherOperatingCents = params.budgetLines
    .filter((l) => l.classification === "operating")
    .reduce((sum, l) => sum + Math.round(l.amountCents), 0);

  const estimatedCapitalCents = params.budgetLines
    .filter((l) => l.classification === "capital")
    .reduce((sum, l) => sum + Math.round(l.amountCents), 0);

  const estimatedTotalOperatingCents = estimatedLabourCents + estimatedOtherOperatingCents;
  const estimatedOperatingSurplusCents =
    Math.round(params.contractValueCents) - estimatedTotalOperatingCents;

  const costPerRoadKmCents =
    roadLengthMeters > 0
      ? Math.round(estimatedTotalOperatingCents / (roadLengthMeters / 1000))
      : null;
  const costPerVergeKmCents =
    vergeLengthMeters > 0
      ? Math.round(estimatedTotalOperatingCents / (vergeLengthMeters / 1000))
      : null;
  const costPerSqmCents =
    physicalAreaSqm > 0 ? Math.round(estimatedTotalOperatingCents / physicalAreaSqm) : null;

  return {
    roadLengthMeters,
    vergeLengthMeters,
    physicalAreaSqm,
    effortUnitsSqm,
    weightedDifficultyFactor,
    unknownWidthCount,
    requiredWorkerDays,
    plannedCrewDays,
    plannedWeeks,
    estimatedLabourCents,
    estimatedOtherOperatingCents,
    estimatedTotalOperatingCents,
    estimatedCapitalCents,
    estimatedOperatingSurplusCents,
    costPerRoadKmCents,
    costPerVergeKmCents,
    costPerSqmCents,
  };
}