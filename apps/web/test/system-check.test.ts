import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser } from "@glio/db/test-harness";
import type { SqlExecutor } from "@glio/sync";
import { EXPECTED_POLICIES, configChecks, databaseChecks, tiktokReachable } from "@/lib/system-check";

/** The Diagnostics page's system check: never shows secret values; finds schema, Vault and failure problems. */

let db: TestDb;
let exec: SqlExecutor;

beforeAll(async () => {
  db = await TestDb.create();
  await db.as(superuser, (q) => q(readFileSync(new URL("../../../packages/sync/test/vault-shim.sql", import.meta.url), "utf8")));
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
});
afterAll(async () => {
  await db?.destroy();
});

describe("system check", () => {
  it("configuration: says set / missing and checks the format, never prints a secret", () => {
    const secret = "S3cr3tValueThatMustNotAppear";
    const rows = configChecks({ TIKTOK_APP_ID: "7712114410013065224", TIKTOK_APP_SECRET: `${secret}\n`, DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows.find((r) => r.name === "TIKTOK_APP_ID looks like an app id")!.status).toBe("ok");
    expect(rows.find((r) => r.name === "TIKTOK_APP_SECRET format")!.status).toBe("bad"); // trailing line break
    expect(rows.find((r) => r.name === "RESEND_API_KEY")!.status).toBe("bad");
  });

  it("database: schema at the latest migration, RLS everywhere, Vault round trip works and leaves nothing behind", async () => {
    const rows = await databaseChecks(exec);
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect(by("Server connection").status).toBe("ok");
    expect(by("Tables (migrations applied)").status).toBe("ok");
    expect(by("Functions").status).toBe("ok");
    expect(by("Row-level security policies")).toMatchObject({ status: "ok", detail: `${EXPECTED_POLICIES} (expected ${EXPECTED_POLICIES})` });
    expect(by("Every table has row-level security on").status).toBe("ok");
    expect(by("Vault (token storage) write → read → delete")).toMatchObject({ status: "ok" });
    const [left] = await db.as(superuser, (q) => q("select count(*)::int as n from vault.secrets where name like 'glio/selftest/%'"));
    expect(left!.n).toBe(0);
    expect(by("Data syncs")).toMatchObject({ status: "ok", detail: "none" });
  });

  it("TikTok reachability: a TikTok error answer counts as reachable; a network failure doesn't", async () => {
    const answered = (async () => ({ status: 200, json: async () => ({ code: 40104, message: "Access token is null" }) })) as unknown as typeof fetch;
    expect((await tiktokReachable(answered)).status).toBe("ok");
    const down = (async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); }) as unknown as typeof fetch;
    expect(await tiktokReachable(down)).toMatchObject({ status: "bad", detail: "ENOTFOUND" });
  });
});
