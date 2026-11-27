import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateAssessmentSizing,
  mergeIntervalLength,
  validateAssessmentSections,
} from "@/lib/domain/assessment-calc";
import { approveAssessmentScope, saveAssessmentDraft } from "@/lib/data/assessment-repository";
import { SYNTHETIC_BIZ_A } from "@/lib/data/synthetic-fixtures";
import type { RoadSectionInput, SiteAssessment } from "@/lib/domain/assessment-types";
import type { AuthSession } from "@/lib/domain/types";

const adminSession: AuthSession = {
  userId: "u-admin-a",
  email: "admin@synthetic.worktrack.local",
  fullName: "Admin",
  businessId: SYNTHETIC_BIZ_A,
  businessName: "Biz A",
  role: "admin",
  assignedJobIds: [],
  mode: "synthetic_dev",
};

const ownerSession: AuthSession = {
  ...adminSession,
  userId: "u-owner-a",
  email: "owner@synthetic.worktrack.local",
  role: "owner",
};

describe("Increment B acceptance tests (T01, T02, T03, T04, T24)", () => {
  it("T01: 10 km with two 5m strips -> road 10 km, verge 20 km, 100,000 m²", () => {
    const sections: RoadSectionInput[] = [
      {
        id: "s1",
        label: "Full",
        startChainageMeters: 0,
        endChainageMeters: 10000,
        carriageway: "single",
        strips: [
          { id: "l", side: "left", widthMeters: 5, lengthOverrideMeters: null },
          { id: "r", side: "right", widthMeters: 5, lengthOverrideMeters: null },
        ],
        difficulty: "similar",
        difficultyReasons: [],
        activities: ["cutting"],
        notes: "",
      },
    ];
    const res = calculateAssessmentSizing({
      sections,
      benchmarkProductivitySqm: 250,
      productiveCrewSize: 12,
      roadWorkerDailyRateCents: 25000,
      cookWeeklyRateCents: 50000,
      includeCook: true,
      workdaysPerWeek: 5,
      contractValueCents: 44000000,
      budgetLines: [],
    });
    expect(res.roadLengthMeters).toBe(10000);
    expect(res.vergeLengthMeters).toBe(20000);
    expect(res.physicalAreaSqm).toBe(100000);
    expect(res.effortUnitsSqm).toBe(100000);
  });

  it("T02: 4 x 5m strips over 10 km -> 200,000 m²; shared median + inner_a overlap rejected", () => {
    const dualValid: RoadSectionInput[] = [
      {
        id: "s1",
        label: "Dual",
        startChainageMeters: 0,
        endChainageMeters: 10000,
        carriageway: "dual",
        strips: [
          { id: "1", side: "outer_a", widthMeters: 5, lengthOverrideMeters: null },
          { id: "2", side: "inner_a", widthMeters: 5, lengthOverrideMeters: null },
          { id: "3", side: "inner_b", widthMeters: 5, lengthOverrideMeters: null },
          { id: "4", side: "outer_b", widthMeters: 5, lengthOverrideMeters: null },
        ],
        difficulty: "similar",
        difficultyReasons: [],
        activities: ["cutting"],
        notes: "",
      },
    ];
    expect(validateAssessmentSections(dualValid)).toHaveLength(0);
    const res = calculateAssessmentSizing({
      sections: dualValid,
      benchmarkProductivitySqm: 250,
      productiveCrewSize: 12,
      roadWorkerDailyRateCents: 25000,
      cookWeeklyRateCents: 50000,
      includeCook: true,
      workdaysPerWeek: 5,
      contractValueCents: 0,
      budgetLines: [],
    });
    expect(res.physicalAreaSqm).toBe(200000);
    expect(res.roadLengthMeters).toBe(10000);

    const overlappingMedian: RoadSectionInput[] = [
      {
        ...dualValid[0]!,
        strips: [
          { id: "1", side: "shared_median", widthMeters: 5, lengthOverrideMeters: null },
          { id: "2", side: "inner_a", widthMeters: 5, lengthOverrideMeters: null },
        ],
      },
    ];
    const errs = validateAssessmentSections(overlappingMedian);
    expect(errs.some((e) => /shared median/i.test(e))).toBe(true);
  });

  it("T03: harder difficulty factor 1.30 -> 130% effort while physical area stays 100,000 m²", () => {
    const sections: RoadSectionInput[] = [
      {
        id: "s1",
        label: "Harder",
        startChainageMeters: 0,
        endChainageMeters: 10000,
        carriageway: "single",
        strips: [
          { id: "l", side: "left", widthMeters: 5, lengthOverrideMeters: null },
          { id: "r", side: "right", widthMeters: 5, lengthOverrideMeters: null },
        ],
        difficulty: "harder",
        difficultyReasons: ["thick_grass", "bushes"],
        activities: ["cutting"],
        notes: "",
      },
    ];
    const res = calculateAssessmentSizing({
      sections,
      benchmarkProductivitySqm: 250,
      productiveCrewSize: 12,
      roadWorkerDailyRateCents: 25000,
      cookWeeklyRateCents: 50000,
      includeCook: true,
      workdaysPerWeek: 5,
      contractValueCents: 0,
      budgetLines: [],
    });
    expect(res.physicalAreaSqm).toBe(100000);
    expect(res.effortUnitsSqm).toBe(130000);
    expect(res.weightedDifficultyFactor).toBe(1.3);
  });

  it("T04: GPS denied/offline saves manual distance with explicit source and zero invented coordinates", async () => {
    const saved = await saveAssessmentDraft(ownerSession, {
      jobId: null,
      name: "Offline Manual Road",
      customerName: "Synthetic",
      roadOrArea: "R63 manual",
      directionDescription: "North",
      status: "draft",
      revision: 1,
      startGps: null,
      endGps: null,
      gpsUnavailableReason: "GPS permission denied",
      distanceSource: "manual_distance",
      originalDistanceMeters: 8500,
      acceptedDistanceMeters: 8500,
      distanceOverrideReason: "Bakkie odometer",
      distanceProvisional: true,
      sections: [
        {
          id: "s1",
          label: "Main",
          startChainageMeters: 0,
          endChainageMeters: 8500,
          carriageway: "single",
          strips: [{ id: "l", side: "left", widthMeters: 3, lengthOverrideMeters: null }],
          difficulty: "similar",
          difficultyReasons: [],
          activities: ["cutting"],
          notes: "",
        },
      ],
      exclusions: "",
      benchmarkId: "bm-1",
      benchmarkProductivitySqm: 250,
      benchmarkConfidence: "illustrative_assumption",
      productiveCrewSize: 12,
      roadWorkerDailyRateCents: 25000,
      cookWeeklyRateCents: 50000,
      includeCook: true,
      workdaysPerWeek: 5,
      contractValueCents: 0,
      budgetLines: [],
      reviewComment: null,
      revisions: [],
    });

    expect(saved.startGps).toBeNull();
    expect(saved.endGps).toBeNull();
    expect(saved.distanceSource).toBe("manual_distance");
    expect(saved.acceptedDistanceMeters).toBe(8500);
    expect(saved.distanceProvisional).toBe(true);
  });

  it("T24: scope changed after approval creates Rev 2 with mandatory reason while preserving Rev 1 baseline", async () => {
    const draft: SiteAssessment = await saveAssessmentDraft(ownerSession, {
      jobId: null,
      name: "T24 Scope Revision Test",
      customerName: "Agency",
      roadOrArea: "R75",
      directionDescription: "East",
      status: "submitted",
      revision: 1,
      startGps: null,
      endGps: null,
      gpsUnavailableReason: null,
      distanceSource: "manual_chainage",
      originalDistanceMeters: 10000,
      acceptedDistanceMeters: 10000,
      distanceOverrideReason: null,
      distanceProvisional: false,
      sections: [
        {
          id: "s1",
          label: "Main",
          startChainageMeters: 0,
          endChainageMeters: 10000,
          carriageway: "single",
          strips: [
            { id: "l", side: "left", widthMeters: 5, lengthOverrideMeters: null },
            { id: "r", side: "right", widthMeters: 5, lengthOverrideMeters: null },
          ],
          difficulty: "similar",
          difficultyReasons: [],
          activities: ["cutting"],
          notes: "",
        },
      ],
      exclusions: "",
      benchmarkId: "bm-1",
      benchmarkProductivitySqm: 250,
      benchmarkConfidence: "illustrative_assumption",
      productiveCrewSize: 12,
      roadWorkerDailyRateCents: 25000,
      cookWeeklyRateCents: 50000,
      includeCook: true,
      workdaysPerWeek: 5,
      contractValueCents: 44000000,
      budgetLines: [],
      reviewComment: null,
      revisions: [],
    });

    // Owner cannot approve
    await expect(approveAssessmentScope(ownerSession, draft, "Owner try")).rejects.toThrow(/denied/i);

    // Admin approves baseline Rev 1
    const rev1 = await approveAssessmentScope(adminSession, draft, "Initial baseline");
    expect(rev1.status).toBe("approved");
    expect(rev1.revision).toBe(1);
    expect(rev1.revisions).toHaveLength(1);
    expect(rev1.revisions[0]!.physicalAreaSqm).toBe(100000);

    // Amendment without reason rejected
    const expanded: SiteAssessment = {
      ...rev1,
      acceptedDistanceMeters: 12000,
      sections: [
        {
          ...rev1.sections[0]!,
          endChainageMeters: 12000,
        },
      ],
    };
    await expect(approveAssessmentScope(adminSession, expanded, "")).rejects.toThrow(/reason/i);

    // Amendment with reason creates Rev 2 while keeping Rev 1 intact
    const rev2 = await approveAssessmentScope(adminSession, expanded, "Client added 2 km extension");
    expect(rev2.revision).toBe(2);
    expect(rev2.revisions).toHaveLength(2);
    expect(rev2.revisions[0]!.physicalAreaSqm).toBe(100000);
    expect(rev2.revisions[1]!.physicalAreaSqm).toBe(120000);
  });

  it("merges overlapping road chainage intervals without double counting road length", () => {
    expect(
      mergeIntervalLength([
        [0, 5000],
        [3000, 8000],
        [9000, 10000],
      ]),
    ).toBe(9000);
  });

  it("Increment B SQL migration enforces RLS and grants without anon access", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "db/migrations/202611270002_increment_b_assessments.sql"),
      "utf8",
    );
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/g)].map((m) => m[1]!);
    expect(tables).toEqual(expect.arrayContaining(["benchmarks", "assessments", "assessment_revisions"]));
    for (const t of tables) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toMatch(new RegExp(`GRANT .* ON public\\.${t} TO authenticated;`));
      expect(sql).toContain(`GRANT ALL ON public.${t} TO service_role;`);
      expect(sql).not.toMatch(new RegExp(`GRANT .* ON public\\.${t} TO anon;`));
    }
  });
});