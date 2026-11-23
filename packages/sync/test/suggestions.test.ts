import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import { DEMO_EXTERNAL_ID, TikTokConnector, demoTikTokFetch } from "@glio/connectors";
import {
  type Evidence, InMemorySecretStore, RULES_AGENT, type SqlExecutor, executeApproval, runSync, suggestForClient,
} from "../src/index.ts";

/**
 * GLIO suggestions (rules v1) on synthetic demo data: the right rule fires for
 * the right campaign, every number in the evidence equals the stored metrics,
 * nothing is executed, no duplicates, guardrails respected, and an approved
 * suggestion goes through the normal executor.
 */

const WINDOW = { from: "2026-11-10", to: "2026-11-16" };
let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let ws: string;
const secrets = new InMemorySecretStore();
const deps = () => ({ db: exec, secrets });

/** A client with the demo account; each in its own workspace (an ad account belongs to one client per workspace). */
async function demoClient(name: string): Promise<{ client: string; account: string }> {
  ws = (await db.as(user(owner), (q) => q("select public.create_workspace($1, 'agency') as id", [`Test Agency ${name}`])))[0]!.id;
  const [c] = await db.as(user(owner), (q) => q("insert into clients (workspace_id, name) values ($1, $2) returning id", [ws, name]));
  const [a] = await db.as(user(owner), (q) => q(
    "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status) values ($1, $2, 'tiktok', $3, 'SAR', 'active') returning id",
    [ws, c!.id, DEMO_EXTERNAL_ID]));
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'demo://synthetic')", [a!.id, ws]);
  const sync = await runSync(
    { db: exec, connector: new TikTokConnector({ fetch: demoTikTokFetch }), secrets, retry: { sleep: async () => {} } },
    { adAccountId: a!.id, kind: "manual", dateFrom: WINDOW.from, dateTo: WINDOW.to },
  );
  expect(sync.status).toBe("succeeded");
  return { client: c!.id, account: a!.id };
}
const requests = (client: string) => db.as(superuser, (q) => q(
  "select id, kind, status, target_id, payload, requested_by, requested_by_agent, reason from approval_requests where client_id = $1 order by target_id", [client]));

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  owner = await db.createUser("owner-sg@example.test");
  await secrets.put("demo://synthetic", "demo-token-not-real");
});

afterAll(async () => {
  await db?.destroy();
});

describe("suggestion rules v1", () => {
  let client: string;

  it("pauses the campaign with spend and no conversions, cuts the expensive one, raises the strong one; leaves A and B alone", async () => {
    ({ client } = await demoClient("Test Client SG1"));
    const out = await suggestForClient(deps(), { clientId: client, yesterday: WINDOW.to });
    expect(out.created.map((c) => [c.campaignId, c.rule]).sort()).toEqual([
      ["demo-campaign-c", "pause_no_conversions"],
      ["demo-campaign-d", "raise_budget_low_cpa"],
      ["demo-campaign-e", "cut_budget_high_cpa"],
    ]);
    const rows = await requests(client);
    expect(rows.every((r) => r.status === "pending" && r.requested_by === null && r.requested_by_agent === RULES_AGENT)).toBe(true);
    const byTarget = Object.fromEntries(rows.map((r) => [r.target_id, r]));
    expect(byTarget["demo-campaign-c"]!.kind).toBe("campaign.pause");
    expect(byTarget["demo-campaign-d"]!.payload.budget_minor).toBe("18000"); // SAR 150 + 20%
    expect(byTarget["demo-campaign-e"]!.payload.budget_minor).toBe("12000"); // SAR 150 - 20%
  });

  it("every number in the evidence equals the stored metrics", async () => {
    for (const r of await requests(client)) {
      const e = r.payload.evidence as Evidence;
      const [m] = await db.as(superuser, (q) => q(
        `select sum(spend_minor)::text as spend, trim(trailing '.' from trim(trailing '0' from sum(conversions)::text)) as conv
         from metric_daily where client_id = $1 and entity_id = $2 and date between $3 and $4`,
        [client, r.target_id, WINDOW.from, WINDOW.to]));
      expect(e.spend_minor).toBe(m!.spend);
      expect(e.conversions).toBe(m!.conv === "" ? "0" : m!.conv);
      expect(e.window).toEqual(WINDOW);
      expect(r.reason).toContain(`${WINDOW.from} to ${WINDOW.to}`);
    }
  });

  it("running again creates nothing new while requests are open", async () => {
    const out = await suggestForClient(deps(), { clientId: client, yesterday: WINDOW.to });
    expect(out.created).toEqual([]);
    expect(out.skipped.filter((s) => s.reason === "open_or_recent_request").map((s) => s.campaignId).sort())
      .toEqual(["demo-campaign-c", "demo-campaign-d", "demo-campaign-e"]);
  });

  it("an approved suggestion runs through the normal executor; a rejected one isn't suggested again for 7 days", async () => {
    const rows = await requests(client);
    const pause = rows.find((r) => r.target_id === "demo-campaign-c")!;
    const cut = rows.find((r) => r.target_id === "demo-campaign-e")!;
    await db.as(user(owner), (q) => q("select public.decide_approval($1, true)", [pause.id]));
    expect(await executeApproval(deps(), { approvalId: pause.id, executedBy: owner })).toMatchObject({ status: "executed", after: { status: "DISABLE" } });
    await db.as(user(owner), (q) => q("select public.decide_approval($1, false, 'not now')", [cut.id]));

    const out = await suggestForClient(deps(), { clientId: client, yesterday: WINDOW.to });
    expect(out.created).toEqual([]);
    const audit = await db.as(superuser, (q) => q("select count(*)::int as n from audit_log where action = 'approval.suggested' and actor_kind = 'agent'"));
    expect(audit[0]!.n).toBe(3);
  });

  it("raises are limited by the client's safety limits, and say so", async () => {
    const { client: c2 } = await demoClient("Test Client SG2");
    await db.as(user(owner), (q) => q(
      "insert into client_guardrails (workspace_id, client_id, max_daily_budget_minor, max_budget_increase_pct) values ($1, $2, 16000, 50)", [ws, c2]));
    await suggestForClient(deps(), { clientId: c2, yesterday: WINDOW.to });
    const raise = (await requests(c2)).find((r) => r.target_id === "demo-campaign-d")!;
    expect(raise.payload.budget_minor).toBe("16000");
    expect(raise.payload.evidence.limited_by_guardrail).toBe(true);
  });

  it("campaigns of inactive (disconnected) accounts are not judged", async () => {
    const { client: c3 } = await demoClient("Test Client SG3");
    await exec.query("update ad_accounts set status = 'disconnected' where client_id = $1", [c3]);
    const out = await suggestForClient(deps(), { clientId: c3, yesterday: WINDOW.to });
    expect(out.created).toEqual([]);
  });
});
