import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import { type FetchLike, TikTokConnector } from "@glio/connectors";
import { InMemorySecretStore, type SqlExecutor, purgeExpiredData, refreshIntraday } from "../src/index.ts";

/**
 * Today so far (migration 0016): provisional day and hourly rows per campaign, fetched
 * at most once per interval, archived like every response, replaced as a whole, never
 * written to metric_daily, and purged after 14 days with their raw responses.
 */

const DAY = "2026-11-26";
let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let account: string;
let calls: Array<{ dims: string[]; metrics: string[] }> = [];
let campaigns = ["test-camp-1", "test-camp-2"];
let failNext = false;
const secrets = new InMemorySecretStore();

const page = (list: unknown[]) => ({ code: 0, message: "OK", request_id: `r-${Math.random()}`, data: { list, page_info: { page: 1, page_size: 1000, total_number: list.length, total_page: 1 } } });
const fakeFetch: FetchLike = async (url) => {
  const p = new URL(url).searchParams;
  const dims = JSON.parse(p.get("dimensions")!);
  calls.push({ dims, metrics: JSON.parse(p.get("metrics")!) });
  if (failNext) { failNext = false; return { status: 200, json: async () => ({ code: 40105, message: "token invalid" }) }; }
  if (dims.includes("stat_time_hour")) {
    return { status: 200, json: async () => page(campaigns.flatMap((c, i) => [9, 10].map((h) => ({
      dimensions: { campaign_id: c, stat_time_hour: `${DAY} ${String(h).padStart(2, "0")}:00:00` },
      metrics: { campaign_name: `Test ${c}`, spend: `${10 + i}.50`, impressions: "1000", clicks: "20", conversion: "2" },
    })))) };
  }
  return { status: 200, json: async () => page(campaigns.map((c, i) => ({
    dimensions: { campaign_id: c, stat_time_day: `${DAY} 00:00:00` },
    metrics: { campaign_name: `Test ${c}`, spend: `${21 + 2 * i}.00`, impressions: "2000", clicks: "40", conversion: "4", total_complete_payment_rate: "300.00" },
  }))) };
};
const deps = () => ({ db: exec, connector: new TikTokConnector({ fetch: fakeFetch }), secrets, retry: { sleep: async () => {} } });
const today = (interval = 10) => refreshIntraday(deps(), { adAccountId: account, day: DAY, grains: ["day", "hour"], minIntervalMinutes: interval });
const rows = () => db.as(superuser, (q) => q(
  "select entity_id, grain, hour, spend_minor::text as spend, purchase_value_minor::text as value from metric_intraday order by entity_id, grain, hour"));

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  owner = await db.createUser("owner-today@example.test");
  const ws = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency Today', 'agency') as id")))[0]!.id;
  const [c] = await db.as(user(owner), (q) => q("insert into clients (workspace_id, name) values ($1, 'Test Client Today') returning id", [ws]));
  const [a] = await db.as(user(owner), (q) => q(
    "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status) values ($1, $2, 'tiktok', 'test-adv-today', 'SAR', 'active') returning id", [ws, c!.id]));
  account = a!.id;
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'secret://test/today')", [account, ws]);
  await secrets.put("secret://test/today", "test-token-today");
});
afterAll(async () => db?.destroy());

describe("today so far", () => {
  it("stores the day so far (with purchase value) and each hour (without), in minor units, archived", async () => {
    expect(await today()).toEqual({ status: "refreshed", rows: 6 });
    expect(await rows()).toEqual([
      { entity_id: "test-camp-1", grain: "day", hour: 0, spend: "2100", value: "30000" },
      { entity_id: "test-camp-1", grain: "hour", hour: 9, spend: "1050", value: null },
      { entity_id: "test-camp-1", grain: "hour", hour: 10, spend: "1050", value: null },
      { entity_id: "test-camp-2", grain: "day", hour: 0, spend: "2300", value: "30000" },
      { entity_id: "test-camp-2", grain: "hour", hour: 9, spend: "1150", value: null },
      { entity_id: "test-camp-2", grain: "hour", hour: 10, spend: "1150", value: null },
    ]);
    // Purchase metrics are asked for the day only (TikTok has none per hour).
    const hourly = calls.find((c) => c.dims.includes("stat_time_hour"))!;
    expect(hourly.metrics).not.toContain("total_complete_payment_rate");
    const [run] = await db.as(superuser, (q) => q("select kind, status, date_from::text as d from sync_runs"));
    expect(run).toEqual({ kind: "intraday", status: "succeeded", d: DAY });
    expect((await db.as(superuser, (q) => q("select count(*)::int as n from raw_platform_payloads")))[0]!.n).toBe(2);
    expect((await db.as(superuser, (q) => q("select count(*)::int as n from metric_daily")))[0]!.n).toBe(0);
  });

  it("within the interval nothing is fetched again", async () => {
    calls = [];
    expect(await today()).toEqual({ status: "fresh" });
    expect(calls).toEqual([]);
  });

  it("a refresh replaces the day as a whole (a campaign TikTok no longer reports disappears)", async () => {
    campaigns = ["test-camp-1"];
    expect(await today(0)).toMatchObject({ status: "refreshed", rows: 3 });
    expect((await rows()).map((r) => r.entity_id)).toEqual(["test-camp-1", "test-camp-1", "test-camp-1"]);
  });

  it("a failure is recorded with its code, keeps the last good rows, and doesn't block the next try", async () => {
    failNext = true;
    expect(await today(0)).toEqual({ status: "failed", errorCode: "tiktok_40105" });
    expect((await rows()).length).toBe(3);
    expect(await today(10)).toMatchObject({ status: "fresh" }); // the earlier success is recent
    const [last] = await db.as(superuser, (q) => q("select status, error_code from sync_runs order by started_at desc limit 1"));
    expect(last).toEqual({ status: "failed", error_code: "tiktok_40105" });
  });

  it("signed-in users read today's rows under RLS, never write them", async () => {
    expect((await db.as(user(owner), (q) => q("select count(*)::int as n from metric_intraday")))[0]!.n).toBe(3);
    await expect(db.as(user(owner), (q) => q("delete from metric_intraday"))).rejects.toThrow(/permission denied/);
  });

  it("after 14 days the rows, their raw responses and the runs are purged; daily data is untouched", async () => {
    await db.as(superuser, async (q) => {
      await q("update metric_intraday set day = current_date - 20");
      await q("update sync_runs set started_at = now() - interval '20 days'");
    });
    const out = await purgeExpiredData(exec);
    expect(out).toMatchObject({ metric_intraday: 3 });
    expect(out.intraday_payloads).toBeGreaterThan(0);
    const left = await db.as(superuser, (q) => q(
      "select (select count(*)::int from metric_intraday) as m, (select count(*)::int from raw_platform_payloads) as p, (select count(*)::int from sync_runs) as r"));
    expect(left).toEqual([{ m: 0, p: 0, r: 0 }]);
  });
});
