import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import { DEMO_EXTERNAL_ID, TikTokConnector, demoTikTokFetch } from "@glio/connectors";
import { InMemorySecretStore, type SqlExecutor, deleteClientData, purgeExpiredData, runSync } from "../src/index.ts";

/**
 * Client deletion (ADR-029) and the daily retention purge (migration 0013), on
 * synthetic data: every row with the client's id is gone, its token leaves the
 * secret store, other clients are untouched, and the audit log records it.
 */

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let viewer: string;
let ws: string;
const secrets = new InMemorySecretStore();

async function seededClient(name: string, secretRef: string): Promise<string> {
  const [c] = await db.as(user(owner), (q) => q("insert into clients (workspace_id, name) values ($1, $2) returning id", [ws, name]));
  const client = c!.id as string;
  const [a] = await db.as(user(owner), (q) => q(
    "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status) values ($1, $2, 'tiktok', $3, 'SAR', 'active') returning id",
    [ws, client, `${DEMO_EXTERNAL_ID}-${name}`]));
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, $3)", [a!.id, ws, secretRef]);
  const sync = await runSync(
    { db: exec, connector: new TikTokConnector({ fetch: demoTikTokFetch }), secrets, retry: { sleep: async () => {} } },
    { adAccountId: a!.id, kind: "manual", dateFrom: "2026-11-10", dateTo: "2026-11-16" },
  );
  expect(sync.status).toBe("succeeded");
  // Reports, emails, links, settings, a client viewer and an open invitation for this client.
  await exec.transaction(async (q) => {
    const [comm] = await q(
      `insert into ai_commentary (workspace_id, client_id, input, input_sha256, prompt_version, system_prompt_sha256, source, text_ar, text_en, attempts)
       values ($1, $2, '{}', repeat('b', 64), 'test', repeat('c', 64), 'template', 'نص', 'text', '[]') returning id`, [ws, client]);
    const [snap] = await q(
      `insert into report_snapshots (workspace_id, client_id, date_from, date_to, report, report_sha256, commentary_id, created_by_label)
       values ($1, $2, '2026-11-10', '2026-11-16', '{}', repeat('d', 64), $3, 'test') returning id`, [ws, client, comm!.id]);
    await q(`insert into report_shares (workspace_id, client_id, snapshot_id, token_hash, created_by_label)
             values ($1, $2, $3::uuid, encode(sha256(convert_to($3::text, 'UTF8')), 'hex'), 'test')`, [ws, client, snap!.id]);
    await q(`insert into report_deliveries (workspace_id, client_id, snapshot_id, period_from, period_to, recipient, trigger, status)
             values ($1, $2, $3, '2026-11-10', '2026-11-16', 'recipient@example.test', 'manual', 'sent')`, [ws, client, snap!.id]);
    await q("insert into report_unsubscribes (workspace_id, client_id, email) values ($1, $2, 'stopped@example.test')", [ws, client]);
  });
  await db.as(user(owner), async (q) => {
    await q("insert into report_schedules (workspace_id, client_id, frequency, recipients) values ($1, $2, 'weekly', '{a@example.test}')", [ws, client]);
    await q("insert into suggestion_settings (workspace_id, client_id, enabled) values ($1, $2, false)", [ws, client]);
    await q("insert into client_guardrails (workspace_id, client_id, max_budget_increase_pct) values ($1, $2, 50)", [ws, client]);
  });
  return client;
}

/** Every public table with a client_id column, and how many rows it holds for this client. */
async function rowsFor(client: string): Promise<Record<string, number>> {
  const tables = await db.as(superuser, (q) => q(
    `select c.table_name from information_schema.columns c join information_schema.tables t
       on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'client_id' and t.table_type = 'BASE TABLE'`));
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [r] = await db.as(superuser, (q) => q(`select count(*)::int as n from public.${table_name} where client_id = $1`, [client]));
    out[table_name] = r!.n;
  }
  return out;
}

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  owner = await db.createUser("owner-del@example.test");
  viewer = await db.createUser("viewer-del@example.test");
  ws = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency Del', 'agency') as id")))[0]!.id;
  await secrets.put("secret://test/del-1", "test-token-1");
  await secrets.put("secret://test/del-2", "test-token-2");
});

afterAll(async () => {
  await db?.destroy();
});

describe("deleting a client (ADR-029)", () => {
  let doomed: string;
  let kept: string;

  it("removes every row with the client's id, its token, and its viewer's membership; other clients untouched", async () => {
    doomed = await seededClient("Test Client DEL1", "secret://test/del-1");
    kept = await seededClient("Test Client DEL2", "secret://test/del-2");
    await db.as(user(owner), (q) => q("insert into memberships (workspace_id, user_id, role, client_id) values ($1, $2, 'client_viewer', $3)", [ws, viewer, doomed]));
    const before = await rowsFor(doomed);
    expect(before.metric_daily).toBeGreaterThan(0);
    expect(before.raw_platform_payloads).toBeGreaterThan(0);
    const keptBefore = await rowsFor(kept);

    const r = await deleteClientData({ db: exec, secrets }, { workspaceId: ws, clientId: doomed, deletedBy: owner });
    expect(r).toMatchObject({ deleted: true, clientName: "Test Client DEL1", secretsDeleted: 1, secretsFailed: 0 });
    expect(r.counts.metric_daily).toBe(before.metric_daily);

    const after = await rowsFor(doomed);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    expect(await rowsFor(kept)).toEqual(keptBefore);
    await expect(secrets.get("secret://test/del-1")).rejects.toThrow();
    expect(await secrets.get("secret://test/del-2")).toBe("test-token-2");
    const [m] = await db.as(superuser, (q) => q("select count(*)::int as n from memberships where user_id = $1", [viewer]));
    expect(m!.n).toBe(0);
  });

  it("the audit log keeps a record of the deletion (name and counts only)", async () => {
    const [a] = await db.as(superuser, (q) => q("select actor_user_id, metadata from audit_log where action = 'client.deleted' and entity_id = $1", [doomed]));
    expect(a!.actor_user_id).toBe(owner);
    expect(a!.metadata.name).toBe("Test Client DEL1");
    expect(JSON.stringify(a!.metadata)).not.toContain("example.test");
  });

  it("deleting again, or a client of another workspace, does nothing", async () => {
    expect((await deleteClientData({ db: exec, secrets }, { workspaceId: ws, clientId: doomed, deletedBy: owner })).deleted).toBe(false);
    const otherWs = "00000000-0000-0000-0000-000000000001";
    expect((await deleteClientData({ db: exec, secrets }, { workspaceId: otherWs, clientId: kept, deletedBy: owner })).deleted).toBe(false);
    expect((await rowsFor(kept)).metric_daily).toBeGreaterThan(0);
  });
});

describe("retention purge (migration 0013)", () => {
  it("deletes invitations 90 days after they closed and delivery rows older than 24 months, nothing newer", async () => {
    await db.as(superuser, async (q) => {
      await q(`insert into invitations (workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
               values ($1, 'old-invite@example.test', 'analyst', repeat('7', 64), $2, now() - interval '200 days', now() - interval '193 days'),
                      ($1, 'new-invite@example.test', 'analyst', repeat('8', 64), $2, now() - interval '20 days', now() - interval '13 days')`, [ws, owner]);
    });
    const [snap] = await db.as(superuser, (q) => q("select id, client_id from report_snapshots limit 1"));
    await exec.query(
      `insert into report_deliveries (workspace_id, client_id, snapshot_id, period_from, period_to, recipient, trigger, status, created_at)
       values ($1, $2, $3, '2024-01-01', '2024-01-07', 'old@example.test', 'manual', 'sent', now() - interval '25 months')`,
      [ws, snap!.client_id, snap!.id]);

    expect(await purgeExpiredData(exec)).toEqual({ invitations: 1, report_deliveries: 1 });
    const emails = await db.as(superuser, (q) => q("select email from invitations order by email"));
    expect(emails.map((r) => r.email)).toEqual(["new-invite@example.test"]);
    const recipients = await db.as(superuser, (q) => q("select recipient from report_deliveries"));
    expect(recipients.map((r) => r.recipient)).toEqual(["recipient@example.test"]);
    expect(await purgeExpiredData(exec)).toEqual({ invitations: 0, report_deliveries: 0 });
  });

  it("outside the purge, the delivery log still can't be deleted by the server, and users can't run the purge", async () => {
    await expect(exec.query("delete from report_deliveries")).rejects.toThrow(/permission denied/);
    await expect(exec.query("select set_config('glio.retention_purge', 'report_deliveries', false); delete from report_deliveries"))
      .rejects.toThrow();
    await expect(db.as(user(owner), (q) => q("select public.purge_expired_data()"))).rejects.toThrow(/permission denied/);
  });
});
