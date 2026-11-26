import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import { DEMO_EXTERNAL_ID, TikTokConnector, demoTikTokFetch } from "@glio/connectors";
import {
  InMemorySecretStore, type SqlExecutor, accountDeletionBlockers, deleteWorkspaceData, prepareAccountDeletion, runSync,
} from "../src/index.ts";

/**
 * Workspace deletion and account deletion (ADR-037, migration 0018), on synthetic data.
 */

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let manager: string;
let doomedWs: string;
let keptWs: string;
const secrets = new InMemorySecretStore();
const revoked: string[] = [];
const deps = () => ({ db: exec, secrets, revoke: async (t: string) => { revoked.push(t); } });

async function seed(ws: string, name: string, ref: string): Promise<string> {
  const [c] = await db.as(user(owner), (q) => q("insert into clients (workspace_id, name) values ($1, $2) returning id", [ws, name]));
  const [a] = await db.as(user(owner), (q) => q(
    "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status) values ($1, $2, 'tiktok', $3, 'SAR', 'active') returning id",
    [ws, c!.id, `${DEMO_EXTERNAL_ID}-${name}`]));
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, $3)", [a!.id, ws, ref]);
  const sync = await runSync({ db: exec, connector: new TikTokConnector({ fetch: demoTikTokFetch }), secrets, retry: { sleep: async () => {} } },
    { adAccountId: a!.id, kind: "manual", dateFrom: "2026-11-10", dateTo: "2026-11-12" });
  expect(sync.status).toBe("succeeded");
  await exec.transaction(async (q) => {
    const [comm] = await q(
      `insert into ai_commentary (workspace_id, client_id, input, input_sha256, prompt_version, system_prompt_sha256, source, text_ar, text_en, attempts)
       values ($1, $2, '{}', repeat('b', 64), 'test', repeat('c', 64), 'template', 'نص', 'text', '[]') returning id`, [ws, c!.id]);
    const [snap] = await q(
      `insert into report_snapshots (workspace_id, client_id, date_from, date_to, report, report_sha256, commentary_id, created_by)
       values ($1, $2, '2026-11-10', '2026-11-12', '{}', repeat('d', 64), $3, $4) returning id`, [ws, c!.id, comm!.id, manager]);
    await q(`insert into report_deliveries (workspace_id, client_id, snapshot_id, period_from, period_to, recipient, trigger, status, sent_by)
             values ($1, $2, $3, '2026-11-10', '2026-11-12', 'r@example.test', 'manual', 'sent', $4)`, [ws, c!.id, snap!.id, manager]);
    await q(`insert into approval_requests (workspace_id, client_id, ad_account_id, kind, requested_by, target_type, target_id)
             values ($1, $2, $3, 'campaign.pause', $4, 'campaign', 'demo-campaign-a')`, [ws, c!.id, a!.id, manager]);
  });
  return c!.id;
}

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  owner = await db.createUser("owner-wsdel@example.test");
  manager = await db.createUser("manager-wsdel@example.test");
  doomedWs = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency WsDel', 'agency') as id")))[0]!.id;
  keptWs = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency WsKeep', 'agency') as id")))[0]!.id;
  for (const ws of [doomedWs, keptWs]) {
    await db.as(user(owner), (q) => q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'manager')", [ws, manager]));
  }
  await secrets.put("secret://wsdel/a", "token-wsdel");
  await secrets.put("secret://wsdel/keep", "token-keep");
  await seed(doomedWs, "Test Client WsDel", "secret://wsdel/a");
  await seed(keptWs, "Test Client WsKeep", "secret://wsdel/keep");
  await db.as(user(owner), (q) => q(
    "insert into invitations (workspace_id, email, role, token_hash, invited_by) values ($1, 'invitee@example.test', 'analyst', repeat('9', 64), $2)", [doomedWs, owner]));
});
afterAll(async () => db?.destroy());

const rowsInWorkspace = async (ws: string) => {
  const tables = await db.as(superuser, (q) => q(
    `select c.table_name from information_schema.columns c join information_schema.tables t
       on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE' and c.table_name <> 'audit_log'`));
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    out[table_name] = (await db.as(superuser, (q) => q(`select count(*)::int as n from public.${table_name} where workspace_id = $1`, [ws])))[0]!.n;
  }
  return out;
};

describe("deleting a workspace", () => {
  it("removes every row of the workspace in every table, revokes and deletes its token, keeps the audit record", async () => {
    const keptBefore = await rowsInWorkspace(keptWs);
    const r = await deleteWorkspaceData(deps(), { workspaceId: doomedWs, deletedBy: owner });
    expect(r).toMatchObject({ deleted: true, name: "Test Agency WsDel", tokens: { deleted: 1, revoked: 1, failed: 0 } });
    expect(r.counts.metric_daily).toBeGreaterThan(0);
    expect(Object.entries(await rowsInWorkspace(doomedWs)).filter(([, n]) => n > 0)).toEqual([]);
    expect(await rowsInWorkspace(keptWs)).toEqual(keptBefore);
    expect(revoked).toEqual(["token-wsdel"]);
    expect(await secrets.get("secret://wsdel/keep")).toBe("token-keep");
    const [a] = await db.as(superuser, (q) => q("select actor_user_id, metadata->>'name' as name from audit_log where action = 'workspace.deleted'"));
    expect(a).toEqual({ actor_user_id: owner, name: "Test Agency WsDel" });
  });
});

describe("deleting an account", () => {
  it("is blocked while the person is the only owner of a workspace", async () => {
    expect((await accountDeletionBlockers(exec, owner)).map((b) => b.name)).toEqual(["Test Agency WsKeep"]);
    expect(await accountDeletionBlockers(exec, manager)).toEqual([]);
    await expect(prepareAccountDeletion(exec, owner)).rejects.toMatchObject({ code: "SOLE_OWNER" });
  });

  it("after the sign-in record is deleted, memberships go and history keeps the bare id", async () => {
    await db.as(user(owner), (q) => q(
      "insert into invitations (workspace_id, email, role, token_hash, invited_by) values ($1, 'by-manager@example.test', 'analyst', repeat('8', 64), $2)", [keptWs, owner]));
    await db.as(superuser, (q) => q("update invitations set invited_by = $1 where email = 'by-manager@example.test'", [manager]));
    expect(await prepareAccountDeletion(exec, manager)).toEqual({ workspaces: 1, invitationsCancelled: 1 });
    await db.as(superuser, (q) => q("delete from auth.users where id = $1", [manager]));
    expect((await db.as(superuser, (q) => q("select count(*)::int as n from memberships where user_id = $1", [manager])))[0]!.n).toBe(0);
    const history = await db.as(superuser, (q) => q(
      `select (select count(*)::int from report_snapshots where created_by = $1) as snaps,
              (select count(*)::int from report_deliveries where sent_by = $1) as sends,
              (select count(*)::int from approval_requests where requested_by = $1) as asks`, [manager]));
    expect(history).toEqual([{ snaps: 1, sends: 1, asks: 1 }]);
    const [left] = await db.as(superuser, (q) => q("select count(*)::int as n from audit_log where action = 'member.account_deleted' and actor_user_id = $1", [manager]));
    expect(left!.n).toBe(1);
  });
});
