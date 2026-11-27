import { format, startOfWeek, endOfWeek, parseISO, isValid } from "date-fns";

export const WORKTRACK_TIMEZONE = "Africa/Johannesburg";
export const WORKTRACK_CURRENCY = "ZAR";

/**
 * Format integer ZAR cents into readable South African Rand (e.g. R 15 500.00 or R 250.00).
 */
export function formatZarCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absCents = Math.abs(Math.round(cents));
  const rands = Math.floor(absCents / 100);
  const remainder = String(absCents % 100).padStart(2, "0");
  const grouped = rands.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}R ${grouped}.${remainder}`;
}

/**
 * Parse a user-entered ZAR string (e.g. "250", "250.50", "R 1 200.00") into integer cents.
 * Returns null if invalid or non-numeric.
 */
export function parseZarToCents(raw: string): number | null {
  const cleaned = raw.replace(/[Rr\s,]/g, "").trim();
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = "0", fracPart = ""] = unsigned.split(".");
  const cents = Number(wholePart) * 100 + Number(fracPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Format an ISO date string (YYYY-MM-DD or timestamp) as `dd MMM yyyy` per spec Section 3.
 */
export function formatDateSA(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  const dateOnly = isoDate.length === 10 ? parseISO(isoDate) : new Date(isoDate);
  if (!isValid(dateOnly)) return "—";
  return format(dateOnly, "dd MMM yyyy");
}

/**
 * Return today's date in Africa/Johannesburg (SAST) as YYYY-MM-DD.
 */
export function todaySAST(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WORKTRACK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "2026";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * Compute the Mon–Sun week range containing a YYYY-MM-DD date.
 */
export function getMonSunWeekRange(isoDate: string): { start: string; end: string } {
  const parsed = parseISO(isoDate);
  const weekStart = startOfWeek(parsed, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(parsed, { weekStartsOn: 1 });
  return {
    start: format(weekStart, "yyyy-MM-dd"),
    end: format(weekEnd, "yyyy-MM-dd"),
  };
}