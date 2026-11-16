import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestDb, service, superuser, user } from "@glio/db/test-harness";
import { type FetchLike, TikTokConnector } from "@glio/connectors";
import { EXPECTED_TOTALS, PAGE_1, PAGE_2, tiktokAccountTotals, tiktokReportPage } from "../../connectors/test/fixtures/tiktok-report.js";
import { InMemorySecretStore, type SqlExecutor, compareMetric, reconcile, runSync } from "../src/index.js";

/**
 * M3 GATE: a seeded 0.4% drift is hidden (ok), a seeded 3% drift is flagged,
 * and every check is logged (stored rows + a structured log event).
 */

const TOKEN = "test-tiktok-token-reconcile";
let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let wsId: string;
let clientId: string;
let accountId: string;
let syncRunId: string;
const secrets = new InMemorySecretStore();

let totalsBody: unknown;
const fakeFetch: FetchLike = async (url) => {
  const p = new URL(url).searchParams;
  if (p.get("data_level") === "AUCTION_ADVERTISER") {
    return { status: 200, json: async () => ({ ...(structuredClone(totalsBody) as object), request_id: randomUUID() }) };
  }
  const page = Number(p.get("page"));
  return { status: 200, json: async () => ({ ...(structuredClone(page === 1 ? PAGE_1 : PAGE_2) as object), request_id: randomUUID() }) };
};
const connector = () => new TikTokConnector({ fetch: fakeFetch });

let logs: Array<Record<string, unknown>>;
const run = (args: { thresholdPpm?: number } = {}) =>
  reconcile({ db: exec, connector: connector(), secrets, retry: { sleep: async () => {} }, log: (e) => logs.push(e) }, { syncRunId, ...args });

// Our stored totals (from PAGE_1 + PAGE_2): 337.89 SAR, 30600 impressions, 635 clicks, 29 conversions.
const exact = { spend: "337.89", impressions: String(EXPECTED_TOTALS.impressions), clicks: String(EXPECTED_TOTALS.clicks), conversion: "29" };

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as(service, (q) => q(t, p)), transaction: (fn) => db.as(service, fn) };
  owner = await db.createUser("recon-owner@example.test");
  wsId = (await db.as(user(owner), async (q) => (await q("select public.create_workspace('Test Agency Recon', 'agency') as id"))[0]!)).id;
  await db.as(user(owner), async (q) => {
    clientId = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client R1') returning id", [wsId]))[0]!.id;
    accountId = (await q(
      "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency) values ($1, $2, 'tiktok', 'test-advertiser-1', 'SAR') returning id",
      [wsId, clientId],
    ))[0]!.id;
  });
  await secrets.put("secret://test/recon", TOKEN);
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'secret://test/recon')", [accountId, wsId]);
  const sync = await runSync(
    { db: exec, connector: connector(), secrets, retry: { sleep: async () => {} } },
    { adAccountId: accountId, kind: "manual", dateFrom: "2026-01-01", dateTo: "2026-01-03" },
  );
  expect(sync.status).toBe("succeeded");
  syncRunId = sync.syncRunId;
});

beforeEach(() => {
  logs = [];
  totalsBody = tiktokAccountTotals(exact);
});

afterAll(async () => {
  await db?.destroy();
});

const rowsFor = (checkId: string) =>
  exec.query(
    "select metric, ours::text, theirs::text, drift_ppm::text, threshold_ppm, status, note, platform_payload_id from reconciliation_checks where check_id = $1 order by metric",
    [checkId],
  );

describe("M3 gate", () => {
  it("matching totals: every metric ok, drift 0, check stored and logged", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    const rows = await rowsFor(r.checkId!);
    expect(rows.map((x) => [x.metric, x.status, x.drift_ppm])).toEqual([
      ["clicks", "ok", "0"], ["conversions", "ok", "0"], ["impressions", "ok", "0"], ["spend", "ok", "0"],
    ]);
    expect(rows.find((x) => x.metric === "spend")).toMatchObject({ ours: "33789", theirs: "33789", threshold_ppm: 5000 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "reconciliation", level: "info", status: "ok", checkId: r.checkId });
  });

  it("a seeded 0.4% spend drift is hidden (ok) but still recorded", async () => {
    // Platform says 339.24 SAR; we stored 337.89: |33789 - 33924| / 33924 = 0.398%
    totalsBody = tiktokAccountTotals({ ...exact, spend: "339.24" });
    const r = await run();
    expect(r.status).toBe("ok");
    const spend = (await rowsFor(r.checkId!)).find((x) => x.metric === "spend")!;
    expect(spend).toMatchObject({ ours: "33789", theirs: "33924", drift_ppm: "3979", status: "ok" });
    expect(logs[0]).toMatchObject({ level: "info", status: "ok", drifted: [] });
  });

  it("a seeded 3% spend drift is flagged, recorded with both numbers, and logged as a warning", async () => {
    // Platform says 348.34 SAR: |33789 - 34834| / 34834 = 3.0%
    totalsBody = tiktokAccountTotals({ ...exact, spend: "348.34" });
    const r = await run();
    expect(r.status).toBe("drift");
    const rows = await rowsFor(r.checkId!);
    expect(rows.find((x) => x.metric === "spend")).toMatchObject({ ours: "33789", theirs: "34834", drift_ppm: "29999", status: "drift" });
    expect(rows.filter((x) => x.metric !== "spend").every((x) => x.status === "ok")).toBe(true);
    expect(logs[0]).toMatchObject({
      event: "reconciliation", level: "warn", status: "drift",
      drifted: [{ metric: "spend", ours: "33789", theirs: "34834", driftPpm: "29999" }],
    });
  });

  it("the latest-check view shows the newest result per metric, as the UI will", async () => {
    const latest = await db.as(user(owner), (q) =>
      q("select metric, status from reconciliation_latest where ad_account_id = $1 order by metric", [accountId]),
    );
    expect(latest).toEqual([
      { metric: "clicks", status: "ok" }, { metric: "conversions", status: "ok" },
      { metric: "impressions", status: "ok" }, { metric: "spend", status: "drift" },
    ]);
  });

  it("each check points at the archived platform response it compared against", async () => {
    const r = await run();
    const [row] = await exec.query(
      "select r.payload from reconciliation_checks c join raw_platform_payloads r on r.id = c.platform_payload_id where c.check_id = $1 and c.metric = 'spend'",
      [r.checkId],
    );
    expect(row!.payload.data.list[0].metrics.spend).toBe("337.89");
  });
});

describe("edge cases", () => {
  it("a metric the platform doesn't provide is 'not comparable', never treated as 0", async () => {
    const body = tiktokAccountTotals(exact) as any;
    delete body.data.list[0].metrics.conversion;
    totalsBody = body;
    const r = await run();
    expect(r.status).toBe("not_comparable");
    const conv = (await rowsFor(r.checkId!)).find((x) => x.metric === "conversions")!;
    expect(conv).toMatchObject({ theirs: null, status: "not_comparable", note: "Not provided by platform" });
  });

  it("platform reports no activity while Glio stored some: flagged", async () => {
    const body = tiktokAccountTotals(exact) as any;
    body.data.list = [];
    totalsBody = body;
    const r = await run();
    expect(r.status).toBe("drift");
    expect((await rowsFor(r.checkId!)).every((x) => x.status === "drift")).toBe(true);
  });

  it("a platform error is logged as a failed check without the token, and stores nothing", async () => {
    totalsBody = { code: 40105, message: `token ${TOKEN} expired`, data: {} };
    const before = (await exec.query("select count(*)::int as n from reconciliation_checks"))[0]!.n;
    const r = await run();
    expect(r).toMatchObject({ status: "failed", checkId: null, errorCode: "tiktok_40105" });
    expect((await exec.query("select count(*)::int as n from reconciliation_checks"))[0]!.n).toBe(before);
    expect(logs[0]).toMatchObject({ event: "reconciliation", level: "error", status: "failed" });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("refuses to reconcile a failed sync run", async () => {
    const [failed] = await exec.query(
      "insert into sync_runs (workspace_id, client_id, ad_account_id, platform, kind, date_from, date_to, status) values ($1, $2, $3, 'tiktok', 'manual', '2026-01-01', '2026-01-01', 'failed') returning id",
      [wsId, clientId, accountId],
    );
    await expect(
      reconcile({ db: exec, connector: connector(), secrets, log: () => {} }, { syncRunId: failed!.id }),
    ).rejects.toThrow(/did not succeed/);
  });
});

describe("checks are a log", () => {
  it("cannot be edited or deleted, even by the server or the superuser", async () => {
    await expect(exec.query("update reconciliation_checks set status = 'ok'")).rejects.toThrow(/permission denied|cannot be changed/);
    await expect(exec.query("delete from reconciliation_checks")).rejects.toThrow(/cannot be changed/);
    await expect(db.as(superuser, (q) => q("update reconciliation_checks set status = 'ok'"))).rejects.toThrow(/cannot be changed/);
    await expect(db.as(superuser, (q) => q("truncate reconciliation_checks"))).rejects.toThrow(/cannot be changed/);
  });

  it("signed-in users can read their checks but not write them", async () => {
    await expect(
      db.as(user(owner), (q) => q("delete from reconciliation_checks")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("compareMetric (exact threshold arithmetic)", () => {
  it.each([
    [10050n, 10000n, "ok", 5000n], // exactly 0.5%: not flagged (must be strictly greater)
    [10051n, 10000n, "drift", 5100n], // just over
    [9950n, 10000n, "ok", 5000n], // under by exactly 0.5%
    [9949n, 10000n, "drift", 5100n],
    [0n, 0n, "ok", 0n],
    [5n, 0n, "drift", 1_000_000n], // platform 0, ours not: always flagged
  ])("ours %s vs theirs %s -> %s", (ours, theirs, status, ppm) => {
    const r = compareMetric("spend", ours, theirs, 5000);
    expect(r.status).toBe(status);
    expect(r.driftPpm).toBe(ppm);
  });

  it("missing values are not comparable", () => {
    expect(compareMetric("clicks", 1n, null, 5000).status).toBe("not_comparable");
    expect(compareMetric("clicks", null, 1n, 5000).status).toBe("not_comparable");
  });
});
