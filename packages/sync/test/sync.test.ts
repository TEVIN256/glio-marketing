import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestDb, service, superuser, user } from "@glio/db/test-harness";
import { type FetchLike, TikTokConnector } from "@glio/connectors";
import { EXPECTED_TOTALS, PAGE_1, PAGE_2, tiktokReportPage } from "../../connectors/test/fixtures/tiktok-report.ts";
import { InMemorySecretStore, type SqlExecutor, backfillWindow, runSync, scheduledWindow } from "../src/index.ts";

/**
 * M2 GATE: re-running a sync for the same window produces zero duplicate rows
 * and byte-identical normalized totals. Plus: raw payloads archived and
 * immutable, failures write nothing, retries on transient errors, tokens
 * never stored.
 */

const TOKEN = "test-tiktok-token-must-never-be-stored";
const WINDOW = { dateFrom: "2026-01-01", dateTo: "2026-01-03" };

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let viewerOther: string;
let wsId: string;
let clientId: string;
let otherClientId: string;
let accountId: string;
const secrets = new InMemorySecretStore();

/** Fake TikTok HTTP layer. Each call gets a fresh request_id, like the real API. */
let pages: Record<number, unknown>;
let failures: number[]; // HTTP statuses to return before succeeding
let requests: string[];
const fakeFetch: FetchLike = async (url, init) => {
  requests.push(url);
  if (JSON.stringify(init?.headers ?? {}).includes(TOKEN) === false) throw new Error("token missing from header");
  const status = failures.shift();
  if (status) return { status, json: async () => ({}) };
  const page = Number(new URL(url).searchParams.get("page"));
  const body = structuredClone(pages[page]) as { request_id?: string };
  body.request_id = randomUUID();
  return { status: 200, json: async () => body };
};

const connector = () => new TikTokConnector({ fetch: fakeFetch });
const noSleep = { sleep: async () => {}, baseDelayMs: 1 };
const sync = (overrides: Partial<Parameters<typeof runSync>[1]> = {}) =>
  runSync({ db: exec, connector: connector(), secrets, retry: noSleep }, { adAccountId: accountId, kind: "manual", ...WINDOW, ...overrides });

const dumpMetrics = () =>
  exec.query(
    `select level, entity_id, entity_name, date::text, currency, spend_minor::text, impressions::text, clicks::text,
            conversions::text, raw_payload_id::text, sync_run_id::text, updated_at::text
     from metric_daily where ad_account_id = $1 order by level, entity_id, date`,
    [accountId],
  );
const totals = async () =>
  (await exec.query(
    `select count(*)::int as rows, sum(spend_minor)::text as spend_minor, sum(impressions)::text as impressions,
            sum(clicks)::text as clicks, sum(conversions)::text as conversions
     from metric_daily where ad_account_id = $1`,
    [accountId],
  ))[0]!;
const count = async (table: string) =>
  (await exec.query(`select count(*)::int as n from public.${table} where ad_account_id = $1`, [accountId]))[0]!.n as number;

beforeAll(async () => {
  db = await TestDb.create();
  exec = {
    query: (text, params) => db.as(service, (q) => q(text, params)),
    transaction: (fn) => db.as(service, fn),
  };
  owner = await db.createUser("sync-owner@example.test");
  viewerOther = await db.createUser("sync-viewer@example.test");
  wsId = (await db.as(user(owner), async (q) => (await q("select public.create_workspace('Test Agency Sync', 'agency') as id"))[0]!)).id;
  await db.as(user(owner), async (q) => {
    clientId = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client S1') returning id", [wsId]))[0]!.id;
    otherClientId = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client S2') returning id", [wsId]))[0]!.id;
    accountId = (await q(
      `insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status)
       values ($1, $2, 'tiktok', 'test-advertiser-1', 'SAR', 'active') returning id`,
      [wsId, clientId],
    ))[0]!.id;
    await q("insert into memberships (workspace_id, user_id, role, client_id) values ($1, $2, 'client_viewer', $3)", [wsId, viewerOther, otherClientId]);
  });
  const ref = `secret://test/${accountId}`;
  await secrets.put(ref, TOKEN);
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, $3)", [accountId, wsId, ref]);
});

beforeEach(() => {
  pages = { 1: PAGE_1, 2: PAGE_2 };
  failures = [];
  requests = [];
});

afterAll(async () => {
  await db?.destroy();
});

describe("M2 gate: idempotent sync", () => {
  it("first sync stores every page and the exact expected totals", async () => {
    const result = await sync();
    expect(result).toMatchObject({ status: "succeeded", pagesFetched: 2, rowsWritten: 6 });
    expect(await totals()).toEqual({
      rows: EXPECTED_TOTALS.rows,
      spend_minor: String(EXPECTED_TOTALS.spend_minor), // 337.89 SAR
      impressions: String(EXPECTED_TOTALS.impressions),
      clicks: String(EXPECTED_TOTALS.clicks),
      conversions: `${EXPECTED_TOTALS.conversions}.0000`,
    });
    expect(await count("raw_platform_payloads")).toBe(2);
    const [v] = await exec.query("select sum(purchase_value_minor)::text as v, count(purchase_value_minor)::int as n from metric_daily");
    expect(v).toEqual({ v: String(EXPECTED_TOTALS.purchase_value_minor), n: 6 }); // SAR 3,272.25, every row has it
  });

  it("re-running the same window creates zero duplicates and byte-identical rows and totals", async () => {
    const beforeRows = JSON.stringify(await dumpMetrics());
    const beforeTotals = JSON.stringify(await totals());
    const beforeRaw = await count("raw_platform_payloads");

    for (let i = 0; i < 3; i++) {
      const result = await sync();
      expect(result).toMatchObject({ status: "succeeded", pagesFetched: 2, rowsWritten: 0 });
    }

    expect(JSON.stringify(await dumpMetrics())).toBe(beforeRows);
    expect(JSON.stringify(await totals())).toBe(beforeTotals);
    // Every call returned a new request_id, but the data was identical: stored once.
    expect(await count("raw_platform_payloads")).toBe(beforeRaw);
    const runs = await exec.query("select status from sync_runs where ad_account_id = $1", [accountId]);
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  });

  it("a platform restatement updates the changed rows only, still no duplicates", async () => {
    pages = {
      1: PAGE_1,
      2: tiktokReportPage(
        [
          { campaign: "test-campaign-002", name: "Test Campaign Two", day: "2026-01-01", spend: "45.10", impressions: "5000", clicks: "80", conversion: "3" },
          { campaign: "test-campaign-002", name: "Test Campaign Two", day: "2026-01-02", spend: "60.00", impressions: "6100", clicks: "95", conversion: "6" }, // late conversions: 4 -> 6
          { campaign: "test-campaign-002", name: "Test Campaign Two", day: "2026-01-03", spend: "12.30", impressions: "1500", clicks: "20", conversion: "1" },
        ],
        2, 2, 6,
      ),
    };
    const result = await sync();
    expect(result).toMatchObject({ status: "succeeded", rowsWritten: 3 }); // the 3 rows from the changed page now cite the new payload
    const t = await totals();
    expect(t.rows).toBe(6);
    expect(t.conversions).toBe(`${EXPECTED_TOTALS.conversions + 2}.0000`);
    expect(t.spend_minor).toBe(String(EXPECTED_TOTALS.spend_minor));
    expect(await count("raw_platform_payloads")).toBe(3); // the new version of page 2 is kept alongside the old one
  });

  it("every metric row points at the raw payload that contains its numbers", async () => {
    const rows = await exec.query(
      `select m.entity_id, m.date::text as date, m.spend_minor::text as spend_minor, r.payload
       from metric_daily m join raw_platform_payloads r on r.id = m.raw_payload_id
       where m.ad_account_id = $1`,
      [accountId],
    );
    for (const row of rows) {
      const item = row.payload.data.list.find(
        (i: any) => i.dimensions.campaign_id === row.entity_id && i.dimensions.stat_time_day.startsWith(row.date),
      );
      expect(item, `${row.entity_id} ${row.date} not found in its raw payload`).toBeDefined();
      expect(BigInt(row.spend_minor)).toBe(BigInt(item.metrics.spend.replace(".", "")));
    }
  });
});

describe("failures, retries and safety", () => {
  it("retries transient errors and then succeeds", async () => {
    failures = [429, 503];
    const result = await sync();
    expect(result.status).toBe("succeeded");
    expect(requests.length).toBe(4); // 2 failures + 2 pages
  });

  it("a failed run writes no metrics and records the error without the token", async () => {
    const before = JSON.stringify(await dumpMetrics());
    // Page 1 succeeds, page 2 keeps failing with a TikTok business error that echoes the token.
    pages = { 1: PAGE_1, 2: { code: 40001, message: `invalid token ${TOKEN}`, data: {} } };
    const result = await sync();
    expect(result).toMatchObject({ status: "failed", errorCode: "tiktok_40001", rowsWritten: 0 });
    expect(JSON.stringify(await dumpMetrics())).toBe(before);

    const [run] = await exec.query("select status, error_message from sync_runs where id = $1", [result.syncRunId]);
    expect(run!.status).toBe("failed");
    expect(run!.error_message).not.toContain(TOKEN);
  });

  it("the token never appears anywhere in the database", async () => {
    const dump = await db.as(superuser, (q) =>
      q(`select (select string_agg(row_to_json(t)::text, '') from sync_runs t) as a,
                (select string_agg(row_to_json(t)::text, '') from raw_platform_payloads t) as b,
                (select string_agg(row_to_json(t)::text, '') from metric_daily t) as c,
                (select string_agg(row_to_json(t)::text, '') from ad_account_credentials t) as d`),
    );
    expect(JSON.stringify(dump)).not.toContain(TOKEN);
  });

  it("rejects numbers that would need rounding instead of storing them", async () => {
    pages = { 1: tiktokReportPage([{ campaign: "test-campaign-001", name: "Test Campaign One", day: "2026-01-01", spend: "1.005", impressions: "1", clicks: "0", conversion: "0" }], 1, 1) };
    const result = await sync();
    expect(result).toMatchObject({ status: "failed", errorCode: "bad_data" });
    const [run] = await exec.query("select error_message from sync_runs where id = $1", [result.syncRunId]);
    expect(run!.error_message).toMatch(/refusing to round/);
  });

  it("rejects dates outside the requested window", async () => {
    pages = { 1: tiktokReportPage([{ campaign: "test-campaign-001", name: "Test Campaign One", day: "2025-12-31", spend: "1.00", impressions: "1", clicks: "0", conversion: "0" }], 1, 1) };
    expect(await sync()).toMatchObject({ status: "failed", errorCode: "bad_data" });
  });

  it("splits a long backfill into the connector's maximum window size", async () => {
    pages = { 1: tiktokReportPage([], 1, 1) };
    const result = await sync({ kind: "backfill", dateFrom: "2026-01-01", dateTo: "2026-03-05" });
    expect(result.status).toBe("succeeded");
    const windows = requests.map((u) => {
      const p = new URL(u).searchParams;
      return `${p.get("start_date")}..${p.get("end_date")}`;
    });
    expect(windows).toEqual(["2026-01-01..2026-01-30", "2026-01-31..2026-03-01", "2026-03-02..2026-03-05"]);
  });
});

describe("raw payloads are immutable", () => {
  it("blocks updates and direct deletes, even for the server", async () => {
    // The server isn't even granted UPDATE; the superuser is, and the trigger still stops it.
    await expect(exec.query("update raw_platform_payloads set payload = '{}'::jsonb")).rejects.toThrow(/permission denied|immutable/);
    await expect(exec.query("delete from raw_platform_payloads")).rejects.toThrow(/immutable/);
    await expect(db.as(superuser, (q) => q("update raw_platform_payloads set endpoint = 'x'"))).rejects.toThrow(/immutable/);
  });

  it("signed-in users can read their client's numbers but never write them", async () => {
    const rows = await db.as(user(owner), (q) => q("select count(*)::int as n from metric_daily"));
    expect(rows[0]!.n).toBe(6);
    await expect(
      db.as(user(owner), (q) => q("update metric_daily set spend_minor = 0")),
    ).rejects.toThrow(/permission denied/);
    // A client_viewer of a different client sees none of this account's data.
    const seen = await db.as(user(viewerOther), (q) =>
      q("select (select count(*) from metric_daily)::int as m, (select count(*) from raw_platform_payloads)::int as r, (select count(*) from sync_runs)::int as s"),
    );
    expect(seen[0]).toEqual({ m: 0, r: 0, s: 0 });
  });

  it("deleting the ad account (e.g. a data deletion request) removes its data through the cascade", async () => {
    const extra = (await db.as(user(owner), (q) =>
      q(`insert into ad_accounts (workspace_id, client_id, platform, external_id, currency) values ($1, $2, 'tiktok', 'test-advertiser-2', 'SAR') returning id`, [wsId, clientId]),
    ))[0]!.id;
    const ref = `secret://test/${extra}`;
    await secrets.put(ref, TOKEN);
    await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, $3)", [extra, wsId, ref]);
    const r = await runSync({ db: exec, connector: connector(), secrets, retry: noSleep }, { adAccountId: extra, kind: "manual", ...WINDOW });
    expect(r.status).toBe("succeeded");

    await db.as(user(owner), (q) => q("delete from ad_accounts where id = $1", [extra]));
    const left = await exec.query(
      `select (select count(*) from metric_daily where ad_account_id = $1)::int as m,
              (select count(*) from raw_platform_payloads where ad_account_id = $1)::int as r,
              (select count(*) from sync_runs where ad_account_id = $1)::int as s`,
      [extra],
    );
    expect(left[0]).toEqual({ m: 0, r: 0, s: 0 });
  });
});

describe("sync windows", () => {
  it("scheduled sync re-pulls the last N days up to yesterday, in Riyadh time", () => {
    // 22:30 UTC on 10 Jan is 11 Jan in Riyadh -> yesterday is 10 Jan
    expect(scheduledWindow({ lookbackDays: 7, now: new Date("2026-01-10T22:30:00Z") })).toEqual({
      dateFrom: "2026-01-04",
      dateTo: "2026-01-10",
    });
  });

  it("backfill validates its range", () => {
    expect(backfillWindow("2026-01-01", "2026-01-31")).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(() => backfillWindow("2026-02-01", "2026-01-01")).toThrow();
    expect(() => backfillWindow("2024-01-01", "2026-01-01")).toThrow(/longer than/);
  });
});

describe("in-app and TikTok Shop values follow the client's choice", () => {
  it("only requests and stores the sources the client selected; the others stay null", async () => {
    const shopPage = structuredClone(PAGE_1) as { data: { list: Array<{ metrics: Record<string, string> }> } };
    for (const r of shopPage.data.list) r.metrics.total_onsite_shopping_value = "10.00";
    pages = { 1: { ...shopPage, data: { ...shopPage.data, page_info: { page: 1, page_size: 1000, total_number: 3, total_page: 1 } } } };
    await db.as(user(owner), (q) =>
      q("insert into client_economics (client_id, workspace_id, value_sources) values ($1, $2, '{website,shop}')", [clientId, wsId]));
    const result = await sync({ dateFrom: "2026-01-01", dateTo: "2026-01-03" });
    expect(result.status).toBe("succeeded");
    const metrics = decodeURIComponent(requests[0]!);
    expect(metrics).toContain("total_onsite_shopping_value");
    expect(metrics).not.toContain("total_purchase_value");
    const rows = await exec.query(
      `select sum(shop_revenue_minor)::text as shop, count(shop_revenue_minor)::int as n_shop,
              count(app_purchase_value_minor)::int as n_app
       from metric_daily where ad_account_id = $1 and entity_id = 'test-campaign-001'`,
      [accountId],
    );
    expect(rows[0]).toEqual({ shop: "3000", n_shop: 3, n_app: 0 }); // SAR 10.00 × 3 days
  });
});
