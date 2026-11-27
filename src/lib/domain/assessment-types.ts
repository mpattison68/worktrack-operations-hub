export type AssessmentStatus = "draft" | "submitted" | "returned" | "approved";

export type DistanceSource =
  | "gps_route"
  | "manual_chainage"
  | "manual_distance";

export type CarriagewayType = "single" | "dual";

export type VergeSide =
  | "left"
  | "right"
  | "outer_a"
  | "inner_a"
  | "inner_b"
  | "outer_b"
  | "shared_median";

export type DifficultyLevel =
  | "much_easier"
  | "easier"
  | "similar"
  | "harder"
  | "much_harder";

export const DIFFICULTY_FACTORS: Record<
  DifficultyLevel,
  { label: string; description: string; factor: number }
> = {
  much_easier: {
    label: "Much easier",
    description: "Light short grass, flat ground, easy access",
    factor: 0.6,
  },
  easier: {
    label: "Easier",
    description: "Mostly open grass with few obstacles",
    factor: 0.8,
  },
  similar: {
    label: "Similar to first job",
    description: "Typical road verge clearing conditions",
    factor: 1.0,
  },
  harder: {
    label: "Harder",
    description: "Thick grass/bushes, slopes, ditches, or heavier litter",
    factor: 1.3,
  },
  much_harder: {
    label: "Much harder",
    description: "Dense bush, steep/rocky terrain, heavy waste, difficult access",
    factor: 1.6,
  },
};

export type DifficultyReason =
  | "thick_grass"
  | "bushes"
  | "slopes"
  | "rocks"
  | "rubbish"
  | "ditches"
  | "manual_clearing"
  | "difficult_truck_access"
  | "traffic"
  | "heavy_waste";

export const DIFFICULTY_REASON_LABELS: Record<DifficultyReason, string> = {
  thick_grass: "Thick grass",
  bushes: "Bushes / shrubs",
  slopes: "Steep slopes",
  rocks: "Rocks / uneven ground",
  rubbish: "Heavy rubbish / litter",
  ditches: "Ditches / drains",
  manual_clearing: "Manual clearing needed",
  difficult_truck_access: "Difficult truck access",
  traffic: "Heavy traffic / safety",
  heavy_waste: "Heavy waste removal",
};

export type ScopeActivity =
  | "cutting"
  | "manual_clearing"
  | "waste_collection"
  | "finishing"
  | "other";

export const SCOPE_ACTIVITY_LABELS: Record<ScopeActivity, string> = {
  cutting: "Grass / brush cutting",
  manual_clearing: "Manual clearing",
  waste_collection: "Waste collection & removal",
  finishing: "Finishing / tidy-up",
  other: "Other specified work",
};

export interface GpsPoint {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  capturedAt: string;
}

export interface VergeStripInput {
  id: string;
  side: VergeSide;
  widthMeters: number | null; // null = unknown, flagged for review (never 0)
  lengthOverrideMeters: number | null; // optional override for discontinuous strip
}

export interface RoadSectionInput {
  id: string;
  label: string;
  startChainageMeters: number;
  endChainageMeters: number;
  carriageway: CarriagewayType;
  strips: VergeStripInput[];
  difficulty: DifficultyLevel;
  difficultyReasons: DifficultyReason[];
  activities: ScopeActivity[];
  notes: string;
}

export interface BudgetLineInput {
  id: string;
  category:
    | "fuel"
    | "food"
    | "rent"
    | "equipment_hire"
    | "maintenance"
    | "transport"
    | "safety"
    | "disposal"
    | "admin"
    | "contingency";
  label: string;
  amountCents: number;
  classification: "operating" | "capital";
}

export interface BenchmarkProfile {
  id: string;
  businessId: string;
  name: string;
  productivitySqmPerWorkerDay: number;
  confidence: "illustrative_assumption" | "estimated" | "verified";
  sourceNote: string;
  version: number;
}

export interface AssessmentRevisionSnapshot {
  revision: number;
  approvedAt: string;
  approvedByEmail: string;
  reason: string;
  acceptedDistanceMeters: number;
  roadLengthMeters: number;
  vergeLengthMeters: number;
  physicalAreaSqm: number;
  effortUnitsSqm: number;
  requiredWorkerDays: number | null;
  plannedCrewDays: number | null;
  estimatedLabourCents: number;
  estimatedOperatingCents: number;
  estimatedCapitalCents: number;
  contractValueCents: number;
  sections: RoadSectionInput[];
}

export interface SiteAssessment {
  id: string;
  businessId: string;
  jobId: string | null;
  name: string;
  customerName: string;
  roadOrArea: string;
  directionDescription: string;
  status: AssessmentStatus;
  revision: number;
  // GPS & distance metadata (null when GPS denied/offline — never invented)
  startGps: GpsPoint | null;
  endGps: GpsPoint | null;
  gpsUnavailableReason: string | null;
  distanceSource: DistanceSource;
  originalDistanceMeters: number;
  acceptedDistanceMeters: number;
  distanceOverrideReason: string | null;
  distanceProvisional: boolean;
  // Scope sections
  sections: RoadSectionInput[];
  exclusions: string;
  // Sizing & budget planning inputs (Admin review)
  benchmarkId: string;
  benchmarkProductivitySqm: number;
  benchmarkConfidence: "illustrative_assumption" | "estimated" | "verified";
  productiveCrewSize: number;
  roadWorkerDailyRateCents: number;
  cookWeeklyRateCents: number;
  includeCook: boolean;
  workdaysPerWeek: number;
  contractValueCents: number;
  budgetLines: BudgetLineInput[];
  // Review & revisions
  reviewComment: string | null;
  revisions: AssessmentRevisionSnapshot[];
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
}