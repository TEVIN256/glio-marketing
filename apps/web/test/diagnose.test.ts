import { describe, expect, it } from "vitest";
import { inspectDatabaseUrl } from "@/lib/diagnose";

const ref = "abcdefghijklmnopqrst";
describe("inspectDatabaseUrl never reveals the password", () => {
  it("describes a correct pooler URL", () => {
    const d = inspectDatabaseUrl(`postgresql://postgres.${ref}:Abc123XyZ789qwerty@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`);
    expect(d).toMatchObject({ user: `postgres.${ref}`, port: "6543", pooler: "transaction (6543)", database: "postgres", hostLooksLikeSupabasePooler: true, userLooksLikePoolerUser: true });
    expect(d.password).toMatchObject({ present: true, length: 18, hasBrackets: false, hasPlaceholderText: false, hasNonAlphanumeric: false });
    expect(JSON.stringify(d)).not.toContain("Abc123XyZ789qwerty");
  });
  it("flags a leftover placeholder, brackets, spaces and missing password", () => {
    expect(inspectDatabaseUrl(`postgresql://postgres.${ref}:[YOUR-PASSWORD]@x.pooler.supabase.com:6543/postgres`).password).toMatchObject({ hasBrackets: true, hasPlaceholderText: true });
    expect(inspectDatabaseUrl(`postgresql://postgres.${ref}:[secret1]@x.pooler.supabase.com:6543/postgres`).password).toMatchObject({ hasBrackets: true, hasPlaceholderText: false });
    expect(inspectDatabaseUrl(`postgresql://postgres.${ref}@x.pooler.supabase.com:6543/postgres`).password).toMatchObject({ present: false });
    expect(inspectDatabaseUrl(` postgresql://postgres.${ref}:abc def@x.pooler.supabase.com:6543/postgres`).password).toMatchObject({ hasWhitespace: true });
    expect(inspectDatabaseUrl("not a url")).toMatchObject({ parseError: expect.any(String) });
    expect(inspectDatabaseUrl(undefined)).toEqual({ present: false });
  });
});
