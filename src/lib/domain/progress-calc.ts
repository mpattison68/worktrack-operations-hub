import {
  DIFFICULTY_FACTORS,
  type RoadSectionInput,
  type ScopeActivity,
  type VergeSide,
} from "@/lib/domain/assessment-types";
import type { ProgressEntry } from "@/lib/domain/increment-c-types";

export interface ChainageInterval {
  start: number;
  end: number;
}

/**
 * Merge overlapping or contiguous [start, end] intervals so no metre is double-counted.
 */
export function mergeIntervals(intervals: ChainageInterval[]): ChainageInterval[] {
  const valid = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (valid.length === 0) return [];

  const merged: ChainageInterval[] = [{ start: valid[0]!.start, end: valid[0]!.end }];
  for (let i = 1; i < valid.length; i++) {
    const next = valid[i]!;
    const last = merged[merged.length - 1]!;
    if (next.start <= last.end) {
      last.end = Math.max(last.end, next.end);
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }
  return merged;
}

/**
 * Intersect two sorted, merged interval arrays.
 */
function intersectTwoSets(a: ChainageInterval[], b: ChainageInterval[]): ChainageInterval[] {
  const result: ChainageInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (end > start) {
      result.push({ start, end });
    }
    if (a[i]!.end < b[j]!.end) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

/**
 * Compute the exact chainage intervals where ALL required activities overlap as complete.
 */
export function intersectIntervalSets(sets: ChainageInterval[][]): ChainageInterval[] {
  if (sets.length === 0) return [];
  let current = mergeIntervals(sets[0]!);
  for (let i = 1; i < sets.length; i++) {
    if (current.length === 0) return [];
    current = intersectTwoSets(current, mergeIntervals(sets[i]!));
  }
  return current;
}

export function sumIntervalLength(intervals: ChainageInterval[]): number {
  return intervals.reduce((sum, iv) => sum + Math.max(0, iv.end - iv.start), 0);
}

export function clampInterval(
  iv: ChainageInterval,
  min: number,
  max: number,
): ChainageInterval | null {
  const start = Math.max(min, iv.start);
  const end = Math.min(max, iv.end);
  return end > start ? { start, end } : null;
}

export interface ActivityProgressMetric {
  activity: ScopeActivity;
  uniqueCompletedMeters: number;
  uniqueCompletedAreaSqm: number;
}

export interface StripProgressSummary {
  sectionId: string;
  sectionLabel: string;
  vergeSide: VergeSide;
  approvedLengthMeters: number;
  widthMeters: number;
  approvedAreaSqm: number;
  difficultyFactor: number;
  approvedWeightedAreaSqm: number;
  activityMetrics: ActivityProgressMetric[];
  fullyCompletedMeters: number;
  fullyCompletedAreaSqm: number;
  fullyCompletedWeightedAreaSqm: number;
}

export interface JobProgressSummary {
  approvedVergeMeters: number;
  approvedPhysicalAreaSqm: number;
  approvedWeightedAreaSqm: number;
  fullyCompletedVergeMeters: number;
  fullyCompletedPhysicalAreaSqm: number;
  fullyCompletedWeightedAreaSqm: number;
  physicalPercent: number;
  effortWeightedPercent: number;
  weeklyIncrementalMeters: number;
  weeklyIncrementalPhysicalAreaSqm: number;
  weeklyIncrementalWeightedAreaSqm: number;
  reworkEntryCount: number;
  reworkMeters: number;
  flaggedConflictCount: number;
  productiveWeeksObserved: number;
  observedWeeklyWeightedSqm: number | null;
  estimatedWeeksRemaining: number | null;
  insufficientHistory: boolean;
  strips: StripProgressSummary[];
}

function computeSnapshotTotals(
  sections: RoadSectionInput[],
  entries: ProgressEntry[],
): {
  approvedVergeMeters: number;
  approvedPhysicalAreaSqm: number;
  approvedWeightedAreaSqm: number;
  fullyCompletedVergeMeters: number;
  fullyCompletedPhysicalAreaSqm: number;
  fullyCompletedWeightedAreaSqm: number;
  strips: StripProgressSummary[];
} {
  let approvedVergeMeters = 0;
  let approvedPhysicalAreaSqm = 0;
  let approvedWeightedAreaSqm = 0;
  let fullyCompletedVergeMeters = 0;
  let fullyCompletedPhysicalAreaSqm = 0;
  let fullyCompletedWeightedAreaSqm = 0;
  const strips: StripProgressSummary[] = [];

  for (const section of sections) {
    const sectionLength = Math.max(0, section.endChainageMeters - section.startChainageMeters);
    const difficultyFactor = DIFFICULTY_FACTORS[section.difficulty].factor;
    const requiredActivities: ScopeActivity[] =
      section.activities.length > 0 ? section.activities : ["cutting"];

    for (const strip of section.strips) {
      const stripLen = strip.lengthOverrideMeters ?? sectionLength;
      const width = strip.widthMeters ?? 0;
      const stripArea = stripLen * width;
      const stripWeightedArea = stripArea * difficultyFactor;

      approvedVergeMeters += stripLen;
      approvedPhysicalAreaSqm += stripArea;
      approvedWeightedAreaSqm += stripWeightedArea;

      const stripEntries = entries.filter(
        (e) =>
          e.sectionId === section.id &&
          e.vergeSide === strip.side &&
          e.stageStatus === "complete" &&
          !e.isRework &&
          e.verificationState !== "flagged_conflict",
      );

      const perActivityIntervals: ChainageInterval[][] = [];
      const activityMetrics: ActivityProgressMetric[] = [];

      for (const act of requiredActivities) {
        const clamped: ChainageInterval[] = [];
        for (const e of stripEntries) {
          if (e.activity !== act) continue;
          const iv = clampInterval(
            { start: e.startChainageMeters, end: e.endChainageMeters },
            section.startChainageMeters,
            section.endChainageMeters,
          );
          if (iv) clamped.push(iv);
        }
        const merged = mergeIntervals(clamped);
        const meters = sumIntervalLength(merged);
        perActivityIntervals.push(merged);
        activityMetrics.push({
          activity: act,
          uniqueCompletedMeters: meters,
          uniqueCompletedAreaSqm: meters * width,
        });
      }

      const fullOverlap = intersectIntervalSets(perActivityIntervals);
      const fullMeters = Math.min(stripLen, sumIntervalLength(fullOverlap));
      const fullArea = fullMeters * width;
      const fullWeighted = fullArea * difficultyFactor;

      fullyCompletedVergeMeters += fullMeters;
      fullyCompletedPhysicalAreaSqm += fullArea;
      fullyCompletedWeightedAreaSqm += fullWeighted;

      strips.push({
        sectionId: section.id,
        sectionLabel: section.label,
        vergeSide: strip.side,
        approvedLengthMeters: stripLen,
        widthMeters: width,
        approvedAreaSqm: stripArea,
        difficultyFactor,
        approvedWeightedAreaSqm: stripWeightedArea,
        activityMetrics,
        fullyCompletedMeters: fullMeters,
        fullyCompletedAreaSqm: fullArea,
        fullyCompletedWeightedAreaSqm: fullWeighted,
      });
    }
  }

  return {
    approvedVergeMeters,
    approvedPhysicalAreaSqm,
    approvedWeightedAreaSqm,
    fullyCompletedVergeMeters,
    fullyCompletedPhysicalAreaSqm,
    fullyCompletedWeightedAreaSqm,
    strips,
  };
}

/**
 * Calculate cumulative, weekly incremental, physical, and effort-weighted progress
 * across all approved sections and strips.
 */
export function calculateJobProgress(
  sections: RoadSectionInput[],
  entries: ProgressEntry[],
  weekRange?: { start: string; end: string },
): JobProgressSummary {
  const cumulativeEntries = weekRange
    ? entries.filter((e) => e.reportedDate <= weekRange.end)
    : entries;
  const priorEntries = weekRange
    ? entries.filter((e) => e.reportedDate < weekRange.start)
    : [];

  const current = computeSnapshotTotals(sections, cumulativeEntries);
  const prior = weekRange ? computeSnapshotTotals(sections, priorEntries) : null;

  const reworkEntries = cumulativeEntries.filter((e) => e.isRework);
  const reworkMeters = reworkEntries.reduce(
    (sum, e) => sum + Math.max(0, e.endChainageMeters - e.startChainageMeters),
    0,
  );
  const flaggedConflictCount = cumulativeEntries.filter(
    (e) => e.verificationState === "flagged_conflict",
  ).length;

  const physicalPercent =
    current.approvedPhysicalAreaSqm > 0
      ? (current.fullyCompletedPhysicalAreaSqm / current.approvedPhysicalAreaSqm) * 100
      : current.approvedVergeMeters > 0
        ? (current.fullyCompletedVergeMeters / current.approvedVergeMeters) * 100
        : 0;

  const effortWeightedPercent =
    current.approvedWeightedAreaSqm > 0
      ? (current.fullyCompletedWeightedAreaSqm / current.approvedWeightedAreaSqm) * 100
      : 0;

  const weeklyIncrementalMeters = prior
    ? Math.max(0, current.fullyCompletedVergeMeters - prior.fullyCompletedVergeMeters)
    : current.fullyCompletedVergeMeters;
  const weeklyIncrementalPhysicalAreaSqm = prior
    ? Math.max(0, current.fullyCompletedPhysicalAreaSqm - prior.fullyCompletedPhysicalAreaSqm)
    : current.fullyCompletedPhysicalAreaSqm;
  const weeklyIncrementalWeightedAreaSqm = prior
    ? Math.max(0, current.fullyCompletedWeightedAreaSqm - prior.fullyCompletedWeightedAreaSqm)
    : current.fullyCompletedWeightedAreaSqm;

  // Count distinct ISO weeks with completed non-rework progress for forecast reliability
  const productiveWeeks = new Set<string>();
  for (const e of cumulativeEntries) {
    if (e.stageStatus === "complete" && !e.isRework && e.verificationState !== "flagged_conflict") {
      // Group by Monday-based week key using simple UTC date arithmetic on YYYY-MM-DD
      const d = new Date(`${e.reportedDate}T00:00:00Z`);
      const day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day);
      productiveWeeks.add(d.toISOString().slice(0, 10));
    }
  }

  const productiveWeeksObserved = productiveWeeks.size;
  const insufficientHistory =
    productiveWeeksObserved < 2 || current.fullyCompletedWeightedAreaSqm <= 0;
  const observedWeeklyWeightedSqm = insufficientHistory
    ? null
    : current.fullyCompletedWeightedAreaSqm / productiveWeeksObserved;
  const remainingWeighted = Math.max(
    0,
    current.approvedWeightedAreaSqm - current.fullyCompletedWeightedAreaSqm,
  );
  const estimatedWeeksRemaining =
    observedWeeklyWeightedSqm && observedWeeklyWeightedSqm > 0
      ? remainingWeighted / observedWeeklyWeightedSqm
      : null;

  return {
    ...current,
    physicalPercent,
    effortWeightedPercent,
    weeklyIncrementalMeters,
    weeklyIncrementalPhysicalAreaSqm,
    weeklyIncrementalWeightedAreaSqm,
    reworkEntryCount: reworkEntries.length,
    reworkMeters,
    flaggedConflictCount,
    productiveWeeksObserved,
    observedWeeklyWeightedSqm,
    estimatedWeeksRemaining,
    insufficientHistory,
  };
}

/**
 * Detect whether a progress entry falls outside the approved section chainage bounds.
 */
export function detectProgressScopeConflict(
  section: RoadSectionInput | undefined,
  startChainageMeters: number,
  endChainageMeters: number,
  activity: ScopeActivity,
): string | null {
  if (!section) return "Selected section is not part of the approved job scope.";
  if (
    startChainageMeters < section.startChainageMeters ||
    endChainageMeters > section.endChainageMeters
  ) {
    return `Entered range (${startChainageMeters}m–${endChainageMeters}m) extends outside approved section chainage (${section.startChainageMeters}m–${section.endChainageMeters}m).`;
  }
  if (section.activities.length > 0 && !section.activities.includes(activity)) {
    return `Activity "${activity}" is not listed in the approved scope for ${section.label}.`;
  }
  return null;
}