import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import { type CampaignState, type CampaignTarget, type CampaignWriter, DEMO_EXTERNAL_ID } from "@glio/connectors";
import { InMemorySecretStore, type SqlExecutor, executeApproval, undoApproval } from "../src/index.ts";

/**
 * M7 GATE: no platform write without an approved request; guardrails block
 * before anything is sent; before/after state saved; undo restores; every
 * step audited; tokens never stored.
 */

const TOKEN = "test-token-for-writes-must-never-be-stored";

class FakeTikTok implements CampaignWriter {
  state = new Map<string, CampaignState>();
  writes: string[] = [];
  async getCampaign(t: CampaignTarget) {
    if (t.accessToken !== TOKEN) throw new Error("wrong token");
    return structuredClone(this.state.get(t.campaignId)!);
  }
  async setStatus(t: CampaignTarget, status: "ENABLE" | "DISABLE") {
    this.writes.push(`status:${t.campaignId}:${status}`);
    this.state.get(t.campaignId)!.status = status;
  }
  async setDailyBudget(t: CampaignTarget, budgetMinor: string) {
    this.writes.push(`budget:${t.campaignId}:${budgetMinor}`);
    this.state.get(t.campaignId)!.budgetMinor = budgetMinor;
  }
}

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let analyst: string;
let ws: string;
let client: string;
let account: string;
let demoAccount: string;
const secrets = new InMemorySecretStore();
const tiktok = new FakeTikTok();
const deps = () => ({ db: exec, secrets, writerFor: (a: { external_id: string }) => (a.external_id === DEMO_EXTERNAL_ID ? undefined! : tiktok) });
const demoDeps = () => ({ db: exec, secrets });

async function propose(kind: string, target: string, payload: object = {}, acct = account): Promise<string> {
  const [r] = await db.as(user(analyst), (q) => q(
    `insert into approval_requests (workspace_id, client_id, kind, payload, requested_by, ad_account_id, target_type, target_id, target_name, reason)
     values ($1, $2, $3, $4, $5, $6, 'campaign', $7, 'Test campaign', 'test') returning id`,
    [ws, client, kind, JSON.stringify(payload), analyst, acct, target]));
  return r!.id;
}
const approve = (id: string) => db.as(user(owner), (q) => q("select public.decide_approval($1, true)", [id]));
const row = async (id: string) => (await db.as(superuser, (q) => q("select * from approval_requests where id = $1", [id])))[0]!;

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  owner = await db.createUser("owner-ap@example.test");
  analyst = await db.createUser("analyst-ap@example.test");
  ws = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency AP', 'agency') as id")))[0]!.id;
  await db.as(user(owner), async (q) => {
    client = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client AP1') returning id", [ws]))[0]!.id;
    account = (await q(
      "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status) values ($1, $2, 'tiktok', 'test-adv-ap', 'SAR', 'active') returning id",
      [ws, client]))[0]!.id;
    demoAccount = (await q(
      "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status) values ($1, $2, 'tiktok', $3, 'SAR', 'active') returning id",
      [ws, client, DEMO_EXTERNAL_ID]))[0]!.id;
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'analyst')", [ws, analyst]);
    await q("insert into client_guardrails (workspace_id, client_id, max_daily_budget_minor, max_budget_increase_pct) values ($1, $2, 100000, 50)", [ws, client]);
  });
  await secrets.put("secret://test/ap", TOKEN);
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'secret://test/ap')", [account, ws]);
  tiktok.state.set("cmp-1", { campaignId: "cmp-1", name: "Test campaign", status: "ENABLE", budgetMinor: "20000", budgetMode: "BUDGET_MODE_DAY" });
  tiktok.state.set("cmp-2", { campaignId: "cmp-2", name: "Test campaign 2", status: "ENABLE", budgetMinor: "20000", budgetMode: "BUDGET_MODE_DAY" });
});

afterAll(async () => {
  await db?.destroy();
});

describe("M7 gate: approval executor", () => {
  it("refuses to run a request that isn't approved, and sends nothing", async () => {
    const id = await propose("campaign.pause", "cmp-1");
    await expect(executeApproval(deps(), { approvalId: id, executedBy: owner })).rejects.toThrow(/is pending/);
    expect(tiktok.writes).toEqual([]);
    expect((await row(id)).status).toBe("pending");
  });

  it("runs an approved pause once, saving the before and after state", async () => {
    const id = await propose("campaign.pause", "cmp-1");
    await approve(id);
    const res = await executeApproval(deps(), { approvalId: id, executedBy: owner });
    expect(res.status).toBe("executed");
    expect(tiktok.writes).toEqual(["status:cmp-1:DISABLE"]);
    const r = await row(id);
    expect(r.status).toBe("executed");
    expect(r.before_state.status).toBe("ENABLE");
    expect(r.after_state.status).toBe("DISABLE");
    expect(r.executed_by).toBe(owner);
    await expect(executeApproval(deps(), { approvalId: id, executedBy: owner })).rejects.toThrow(/is executed/);
    expect(tiktok.writes).toHaveLength(1);
  });

  it("blocks a budget increase above the per-change cap before anything is sent", async () => {
    const id = await propose("campaign.budget", "cmp-2", { budget_minor: "31000" }); // +55% > 50%
    await approve(id);
    const res = await executeApproval(deps(), { approvalId: id, executedBy: owner });
    expect(res).toMatchObject({ status: "failed", errorCode: "GUARDRAIL_MAX_INCREASE" });
    expect(tiktok.writes.filter((w) => w.startsWith("budget"))).toEqual([]);
    expect((await row(id)).before_state.budgetMinor).toBe("20000");
  });

  it("blocks a budget above the client's maximum daily budget", async () => {
    tiktok.state.get("cmp-2")!.budgetMinor = "90000";
    const id = await propose("campaign.budget", "cmp-2", { budget_minor: "110000" });
    await approve(id);
    expect(await executeApproval(deps(), { approvalId: id, executedBy: owner })).toMatchObject({ status: "failed", errorCode: "GUARDRAIL_MAX_DAILY_BUDGET" });
    tiktok.state.get("cmp-2")!.budgetMinor = "20000";
  });

  it("applies an allowed budget change, then undo restores the previous budget (and is refused twice)", async () => {
    const id = await propose("campaign.budget", "cmp-2", { budget_minor: "10000" }); // decrease
    await approve(id);
    expect((await executeApproval(deps(), { approvalId: id, executedBy: owner })).status).toBe("executed");
    expect(tiktok.state.get("cmp-2")!.budgetMinor).toBe("10000");

    const undo = await undoApproval(deps(), { approvalId: id, userId: owner });
    expect(undo.status).toBe("executed"); // +100% back to the old budget: allowed for an undo
    expect(tiktok.state.get("cmp-2")!.budgetMinor).toBe("20000");
    expect((await row(id)).status).toBe("undone");
    expect((await row(undo.undoId)).undo_of).toBe(id);
    await expect(undoApproval(deps(), { approvalId: id, userId: owner })).rejects.toThrow(/Only executed changes/);
  });

  it("only the latest change for a campaign can be undone", async () => {
    tiktok.state.set("cmp-3", { campaignId: "cmp-3", name: "Test campaign 3", status: "ENABLE", budgetMinor: "20000", budgetMode: "BUDGET_MODE_DAY" });
    const first = await propose("campaign.budget", "cmp-3", { budget_minor: "25000" });
    await approve(first);
    await executeApproval(deps(), { approvalId: first, executedBy: owner });
    const second = await propose("campaign.budget", "cmp-3", { budget_minor: "22000" });
    await approve(second);
    await executeApproval(deps(), { approvalId: second, executedBy: owner });
    await expect(undoApproval(deps(), { approvalId: first, userId: owner })).rejects.toThrow(/newer change/);
    expect(tiktok.state.get("cmp-3")!.budgetMinor).toBe("22000");
    expect((await undoApproval(deps(), { approvalId: second, userId: owner })).status).toBe("executed");
    expect(tiktok.state.get("cmp-3")!.budgetMinor).toBe("25000");
  });

  it("undoing a pause re-enables the campaign", async () => {
    const [paused] = await db.as(superuser, (q) => q(
      "select id from approval_requests where kind = 'campaign.pause' and status = 'executed' limit 1"));
    const undo = await undoApproval(deps(), { approvalId: paused!.id, userId: owner });
    expect(undo.status).toBe("executed");
    expect(tiktok.state.get("cmp-1")!.status).toBe("ENABLE");
  });

  it("audits every step and never stores the token", async () => {
    const actions = await db.as(superuser, (q) => q("select action from audit_log where entity_type = 'approval_request' order by id"));
    expect(new Set(actions.map((a) => a.action))).toEqual(new Set(["approval.approved", "approval.executed", "approval.failed", "approval.undo_requested"]));
    const dump = await db.as(superuser, (q) => q(
      "select (select json_agg(a) from approval_requests a)::text || (select json_agg(l) from audit_log l)::text as all"));
    expect(dump[0]!.all).not.toContain(TOKEN);
  });

  it("the demo account's campaigns keep their state across changes (nothing is sent anywhere)", async () => {
    const a = await propose("campaign.budget", "demo-campaign-a", { budget_minor: "12000" }, demoAccount);
    await approve(a);
    expect(await executeApproval(demoDeps(), { approvalId: a, executedBy: owner })).toMatchObject({
      status: "executed", before: { budgetMinor: "15000" }, after: { budgetMinor: "12000" },
    });
    const b = await propose("campaign.pause", "demo-campaign-a", {}, demoAccount);
    await approve(b);
    expect(await executeApproval(demoDeps(), { approvalId: b, executedBy: owner })).toMatchObject({
      status: "executed", before: { budgetMinor: "12000", status: "ENABLE" }, after: { status: "DISABLE" },
    });
  });
});
