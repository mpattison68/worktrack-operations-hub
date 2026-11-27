import { describe, expect, it } from "vitest";
import { formatDateSA, formatZarCents, getMonSunWeekRange, parseZarToCents } from "@/lib/format";
import {
  dateRangesOverlap,
  resolveEffectivePayRule,
  validateJobInput,
  validatePayRuleCandidate,
} from "@/lib/domain/validation";
import type { PayRule } from "@/lib/domain/types";

const baseRule: PayRule = {
  id: "r1",
  businessId: "b1",
  workerRoleId: "role-road",
  payBasis: "daily",
  baseRateCents: 25000,
  normalHoursPerDay: 9,
  normalWorkdaysPerWeek: 5,
  weekdayOtHourlyCents: null,
  saturdayRateCents: null,
  sundayRateCents: null,
  publicHolidayRateCents: null,
  weeklyProrationPolicy: "none",
  effectiveFrom: "2026-11-01",
  effectiveTo: "2026-11-18",
  isConfirmed: true,
  notes: "",
  createdAt: "2026-11-01T00:00:00Z",
};

describe("Increment A ZAR integer-cent & SAST calendar rules", () => {
  it("parses and formats integer ZAR cents deterministically", () => {
    expect(parseZarToCents("250")).toBe(25000);
    expect(parseZarToCents("R 15 500.00")).toBe(1550000);
    expect(parseZarToCents("-125.50")).toBe(-12550);
    expect(parseZarToCents("abc")).toBeNull();
    expect(parseZarToCents("10.123")).toBeNull();
    expect(formatZarCents(1550000)).toBe("R 15 500.00");
    expect(formatZarCents(-25000)).toBe("-R 250.00");
  });

  it("formats dates as dd MMM yyyy and computes Mon–Sun weeks", () => {
    expect(formatDateSA("2026-11-27")).toBe("27 Nov 2026");
    expect(getMonSunWeekRange("2026-11-27")).toEqual({
      start: "2026-11-23",
      end: "2026-11-29",
    });
  });
});

describe("Increment A effective-dated pay rules (T11 foundation)", () => {
  it("rejects overlapping effective ranges for the same role", () => {
    expect(dateRangesOverlap("2026-11-01", "2026-11-18", "2026-11-18", null)).toBe(true);
    expect(dateRangesOverlap("2026-11-01", "2026-11-18", "2026-11-19", null)).toBe(false);

    const overlapErr = validatePayRuleCandidate(
      {
        workerRoleId: "role-road",
        baseRateCents: 27000,
        normalHoursPerDay: 9,
        normalWorkdaysPerWeek: 5,
        effectiveFrom: "2026-11-18",
        effectiveTo: null,
      },
      [baseRule],
    );
    expect(overlapErr).toMatch(/overlap/i);

    const okErr = validatePayRuleCandidate(
      {
        workerRoleId: "role-road",
        baseRateCents: 27000,
        normalHoursPerDay: 9,
        normalWorkdaysPerWeek: 5,
        effectiveFrom: "2026-11-19",
        effectiveTo: null,
      },
      [baseRule],
    );
    expect(okErr).toBeNull();
  });

  it("validates optional overtime, weekend, and public holiday hourly rates and allows editing an existing rule", () => {
    const negativeOtErr = validatePayRuleCandidate(
      {
        workerRoleId: "role-road",
        baseRateCents: 27000,
        normalHoursPerDay: 9,
        normalWorkdaysPerWeek: 5,
        weekdayOtHourlyCents: -500,
        effectiveFrom: "2026-11-19",
        effectiveTo: null,
      },
      [baseRule],
    );
    expect(negativeOtErr).toMatch(/weekday ot/i);

    const zeroSatErr = validatePayRuleCandidate(
      {
        workerRoleId: "role-road",
        baseRateCents: 27000,
        normalHoursPerDay: 9,
        normalWorkdaysPerWeek: 5,
        saturdayRateCents: 0,
        effectiveFrom: "2026-11-19",
        effectiveTo: null,
      },
      [baseRule],
    );
    expect(zeroSatErr).toMatch(/saturday/i);

    const editSelfOk = validatePayRuleCandidate(
      {
        id: "r1",
        workerRoleId: "role-road",
        baseRateCents: 25000,
        normalHoursPerDay: 9,
        normalWorkdaysPerWeek: 5,
        weekdayOtHourlyCents: 5833,
        saturdayRateCents: 5833,
        sundayRateCents: 7778,
        publicHolidayRateCents: 7778,
        effectiveFrom: "2026-11-01",
        effectiveTo: "2026-11-18",
      },
      [baseRule],
    );
    expect(editSelfOk).toBeNull();
  });

  it("resolves old vs new rate across a midweek effective-date change", () => {
    const newRule: PayRule = {
      ...baseRule,
      id: "r2",
      baseRateCents: 28000,
      effectiveFrom: "2026-11-19",
      effectiveTo: null,
    };
    expect(resolveEffectivePayRule([baseRule, newRule], "role-road", "2026-11-18")?.baseRateCents).toBe(25000);
    expect(resolveEffectivePayRule([baseRule, newRule], "role-road", "2026-11-19")?.baseRateCents).toBe(28000);
  });

  it("validates job configuration inputs", () => {
    expect(
      validateJobInput({
        name: "R63 Job",
        customerName: "Agency",
        contractReference: "REF-1",
        contractValueCents: -100,
        roadOrArea: "R63",
        plannedStartDate: "2026-11-01",
        plannedEndDate: "2026-12-01",
        openingCashAllocationCents: 0,
      }),
    ).toMatch(/contract value/i);

    expect(
      validateJobInput({
        name: "R63 Job",
        customerName: "Agency",
        contractReference: "REF-1",
        contractValueCents: 44000000,
        roadOrArea: "R63",
        plannedStartDate: "2026-12-01",
        plannedEndDate: "2026-11-01",
        openingCashAllocationCents: 0,
      }),
    ).toMatch(/end date/i);
  });
});