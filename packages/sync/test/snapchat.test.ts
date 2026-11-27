import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, service, user } from "@glio/db/test-harness";
import { type FetchLike, SnapchatConnector } from "@glio/connectors";
import {
  InMemorySecretStore, SnapchatAccessTokenStore, type SqlExecutor, connectAdAccounts, disconnectAdAccount, newSecretRef,
  reconcile, runSync, suggestForClient,
} from "../src/index.ts";

/** SYNTHETIC Snapchat API (shapes from developers.snap.com). The access token must be the minted one, never the refresh token. */
const ACCOUNT = "test-snap-account-1";
let refreshCalls = 0;
const fetch: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "accounts.snapchat.com") {
    refreshCalls++;
    return { status: 200, json: async () => ({ access_token: "snap-access-1", refresh_token: "snap-refresh-2", expires_in: 3600 }) };
  }
  if (init?.headers?.Authorization !== "Bearer snap-access-1") return { status: 401, json: async () => ({}) };
  if (u.pathname.endsWith("/campaigns")) {
    return { status: 200, json: async () => ({ request_status: "SUCCESS", campaigns: [{ campaign: { id: "test-snap-camp", name: "Test Snap Campaign" } }] }) };
  }
  if (u.pathname.endsWith("/stats") && u.searchParams.get("granularity") === "TOTAL") {
    return { status: 200, json: async () => ({ request_status: "SUCCESS", total_stats: [{ total_stat: { stats: { spend: 150_004_000 } } }] }) };
  }
  if (u.pathname.endsWith("/stats")) {
    return { status: 200, json: async () => ({ request_status: "SUCCESS", request_id: "x", timeseries_stats: [{ timeseries_stat: { breakdown_stats: { campaign: [{ id: "test-snap-camp", timeseries: [
      { start_time: "2026-01-01T00:00:00.000+03:00", stats: { impressions: 1000, swipes: 30, spend: 100_002_000, conversion_purchases: 2, conversion_purchases_value: 300_000_000 } },
      { start_time: "2026-01-02T00:00:00.000+03:00", stats: { impressions: 500, swipes: 10, spend: 50_002_000, conversion_purchases: 1, conversion_purchases_value: 99_990_000 } },
    ] }] } } }] }) };
  }
  return { status: 200, json: async () => ({ request_status: "SUCCESS", adaccounts: [{ adaccount: { id: ACCOUNT, currency: "SAR", timezone: "Asia/Riyadh" } }] }) };
};

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let wsId: string;
let clientId: string;
let accountId: string;
const vault = new InMemorySecretStore();
const ref = newSecretRef("snapchat");
const connector = new SnapchatConnector({ fetch });
const tokens = () => new SnapchatAccessTokenStore(vault, (rt) => connector.refresh({ clientId: "test-client", clientSecret: "test-secret", refreshToken: rt }));

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (text, params) => db.as(service, (q) => q(text, params)), transaction: (fn) => db.as(service, fn) };
  owner = await db.createUser("snap-owner@example.test");
  wsId = (await db.as(user(owner), async (q) => (await q("select public.create_workspace('Test Agency Snap', 'agency') as id"))[0]!)).id;
  clientId = (await db.as(user(owner), async (q) => (await q("insert into clients (workspace_id, name) values ($1, 'Test Client SC1') returning id", [wsId]))[0]!)).id;
});
afterAll(async () => {
  await db?.destroy();
});

describe("Snapchat end to end (synthetic)", () => {
  it("connects with the REFRESH token in the secret store only", async () => {
    const r = await connectAdAccounts({ db: exec, secrets: vault }, {
      workspaceId: wsId, clientId, userId: owner, platform: "snapchat", accessToken: "snap-refresh-1", secretRef: ref,
      accounts: [{ externalId: ACCOUNT, name: "Test Snap Account", currency: "SAR", timezone: "Asia/Riyadh" }],
    });
    accountId = r.connected[0]!.adAccountId;
    expect(await vault.get(ref)).toBe("snap-refresh-1");
    expect(JSON.stringify(await exec.query("select * from ad_accounts a join ad_account_credentials c on c.ad_account_id = a.id"))).not.toContain("snap-refresh");
  });

  it("syncs with a minted access token (refresh token rotated and kept), rounds micro-currency, and reconciles spend", async () => {
    const secrets = tokens();
    const sync = await runSync({ db: exec, connector, secrets, retry: { sleep: async () => {}, baseDelayMs: 1 } },
      { adAccountId: accountId, kind: "manual", dateFrom: "2026-01-01", dateTo: "2026-01-02" });
    expect(sync.status).toBe("succeeded");
    expect(await vault.get(ref)).toBe("snap-refresh-2");
    const rows = await exec.query(
      `select date::text, platform, spend_minor::text as spend, clicks::text, conversions::text, purchase_value_minor::text as value
       from metric_daily where ad_account_id = $1 order by date`, [accountId]);
    expect(rows).toEqual([
      { date: "2026-01-01", platform: "snapchat", spend: "10000", clicks: "30", conversions: "2.0000", value: "30000" },
      { date: "2026-01-02", platform: "snapchat", spend: "5000", clicks: "10", conversions: "1.0000", value: "9999" },
    ]);
    const rec = await reconcile({ db: exec, connector, secrets, retry: { sleep: async () => {} }, log: () => {} }, { syncRunId: sync.syncRunId });
    expect(rec.status).toBe("ok"); // 150.00 stored vs Snap's 150.004 → 150.00
    const metrics = (await exec.query("select metric from reconciliation_checks where ad_account_id = $1", [accountId])).map((r) => r.metric);
    expect(metrics).toContain("spend");
    expect(metrics).not.toContain("impressions"); // Snap's account totals don't report it: not checked, not "not comparable"
    expect(refreshCalls).toBe(1); // one access token reused for the sync and the reconciliation
  });

  it("GLIO's suggestions ignore Snapchat campaigns (no executor for Snapchat)", async () => {
    const out = await suggestForClient({ db: exec, secrets: vault }, { clientId, yesterday: "2026-01-02" });
    expect(out.created).toEqual([]);
    expect(out.skipped.map((s) => s.campaignId)).not.toContain("test-snap-camp");
  });

  it("disconnecting never sends Snapchat's token to TikTok's revoke, and deletes it", async () => {
    const revoked: string[] = [];
    const r = await disconnectAdAccount({ db: exec, secrets: vault, revoke: async (t) => { revoked.push(t); } },
      { workspaceId: wsId, clientId, adAccountId: accountId, userId: owner });
    expect(r.disconnected).toBe(true);
    expect(revoked).toEqual([]);
    expect(vault.has(ref)).toBe(false);
  });
});
