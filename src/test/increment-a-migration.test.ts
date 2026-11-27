import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Increment A portable PostgreSQL migration security invariants", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "db/migrations/202611270001_increment_a_foundation.sql"),
    "utf8",
  );

  const tableNames = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/g)].map(
    (m) => m[1]!,
  );

  it("creates all Increment A foundation tables", () => {
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "businesses",
        "profiles",
        "memberships",
        "invitations",
        "jobs",
        "job_revisions",
        "worker_roles",
        "pay_rules",
        "workers",
        "worker_rate_overrides",
        "worker_assignments",
        "audit_events",
        "mutation_receipts",
      ]),
    );
  });

  it("enables RLS and grants authenticated + service_role (never anon) on every public table", () => {
    for (const table of tableNames) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toMatch(new RegExp(`GRANT .* ON public\\.${table} TO authenticated;`));
      expect(sql).toContain(`GRANT ALL ON public.${table} TO service_role;`);
      expect(sql).not.toMatch(new RegExp(`GRANT .* ON public\\.${table} TO anon;`));
    }
  });

  it("uses SET search_path = public on security-definer helpers and checks pay_rules overlap", () => {
    expect(sql).toContain("SECURITY DEFINER\nSET search_path = public");
    expect(sql).toContain("CREATE TRIGGER trg_pay_rules_no_overlap");
  });
});