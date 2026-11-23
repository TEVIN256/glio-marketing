import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import type { SqlExecutor } from "@glio/sync";
import { type MailMessage, type Mailer, MailError, type PendingItem, notifyPendingApprovals } from "../src/index.ts";

/**
 * Approval notifications: owners and managers who haven't opted out get one
 * email per batch; each request is announced once; failures are retried;
 * other workspaces are never mixed in.
 */

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  failFor = new Set<string>();
  async send(m: MailMessage) {
    if (this.failFor.has(m.to)) throw new MailError("Resend returned HTTP 500", "RESEND_500", true);
    this.sent.push(m);
    return { id: `msg_${this.sent.length}` };
  }
}

let db: TestDb;
let exec: SqlExecutor;
let owner: string, manager: string, analyst: string, viewer: string, outsider: string;
let ws: string, otherWs: string, client: string, otherClient: string, account: string, otherAccount: string;
let rendered: Array<{ workspaceName: string; items: PendingItem[] }>;
const deps = (mailer: Mailer) => ({
  db: exec, mailer, from: "GLIO <reports@example.test>", replyTo: "info@example.test",
  render: (a: { workspaceId: string; workspaceName: string; items: PendingItem[] }) => {
    rendered.push(a);
    return { subject: `${a.items.length} waiting`, html: "<p>x</p>", text: "x" };
  },
});
const propose = async (by: string, target: string, w = ws, c = client, a = account) =>
  (await db.as(user(by), (q) => q(
    `insert into approval_requests (workspace_id, client_id, kind, requested_by, ad_account_id, target_type, target_id, target_name)
     values ($1, $2, 'campaign.pause', $3, $4, 'campaign', $5, 'Test campaign') returning id`, [w, c, by, a, target])))[0]!.id as string;

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  owner = await db.createUser("owner-n@example.test");
  manager = await db.createUser("manager-n@example.test");
  analyst = await db.createUser("analyst-n@example.test");
  viewer = await db.createUser("viewer-n@example.test");
  outsider = await db.createUser("outsider-n@example.test");
  ws = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency N', 'agency') as id")))[0]!.id;
  otherWs = (await db.as(user(outsider), (q) => q("select public.create_workspace('Test Agency M', 'agency') as id")))[0]!.id;
  await db.as(user(owner), async (q) => {
    client = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client N1') returning id", [ws]))[0]!.id;
    account = (await q("insert into ad_accounts (workspace_id, client_id, platform, external_id, currency) values ($1, $2, 'tiktok', 'n-1', 'SAR') returning id", [ws, client]))[0]!.id;
    for (const [u, role, cid] of [[manager, "manager", null], [analyst, "analyst", null], [viewer, "client_viewer", client]]) {
      await q("insert into memberships (workspace_id, user_id, role, client_id) values ($1, $2, $3, $4)", [ws, u, role, cid]);
    }
  });
  await db.as(user(outsider), async (q) => {
    otherClient = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client M1') returning id", [otherWs]))[0]!.id;
    otherAccount = (await q("insert into ad_accounts (workspace_id, client_id, platform, external_id, currency) values ($1, $2, 'tiktok', 'm-1', 'SAR') returning id", [otherWs, otherClient]))[0]!.id;
  });
});

afterAll(async () => {
  await db?.destroy();
});

describe("approval notifications", () => {
  it("emails each owner and manager separately (not analysts or client viewers), once per request", async () => {
    rendered = [];
    const id = await propose(analyst, "cmp-1");
    const mailer = new FakeMailer();
    const [r] = await notifyPendingApprovals(deps(mailer));
    expect(r).toMatchObject({ workspaceId: ws, items: 1, recipients: 2, sent: 2, failed: 0 });
    expect(mailer.sent.map((m) => m.to)).toEqual(["manager-n@example.test", "owner-n@example.test"]);
    expect(rendered[0]!.items.map((i) => [i.id, i.client_name, i.currency])).toEqual([[id, "Test Client N1", "SAR"]]);
    expect(rendered[0]!.workspaceName).toBe("Test Agency N");

    expect(await notifyPendingApprovals(deps(mailer))).toEqual([]);
    expect(mailer.sent).toHaveLength(2);
  });

  it("skips the person whose action created the requests, and people who turned the email off", async () => {
    await propose(owner, "cmp-2");
    await db.as(user(manager), (q) => q("insert into notification_settings (workspace_id, user_id, approvals_email) values ($1, $2, false)", [ws, manager]));
    const mailer = new FakeMailer();
    const [r] = await notifyPendingApprovals(deps(mailer), { workspaceId: ws, excludeUserId: owner });
    expect(r).toMatchObject({ recipients: 0, sent: 0 });
    expect(mailer.sent).toEqual([]);
    // Nobody to tell: marked as announced so it isn't sent later out of context.
    expect(await notifyPendingApprovals(deps(mailer))).toEqual([]);
    await db.as(user(manager), (q) => q("update notification_settings set approvals_email = true where user_id = $1", [manager]));
  });

  it("if every send fails the requests stay unannounced and are retried", async () => {
    const id = await propose(analyst, "cmp-3");
    const failing = new FakeMailer();
    failing.failFor = new Set(["owner-n@example.test", "manager-n@example.test"]);
    expect(await notifyPendingApprovals(deps(failing))).toMatchObject([{ sent: 0, failed: 2 }]);
    const [row] = await db.as(superuser, (q) => q("select notified_at from approval_requests where id = $1", [id]));
    expect(row!.notified_at).toBeNull();
    const ok = new FakeMailer();
    expect(await notifyPendingApprovals(deps(ok))).toMatchObject([{ sent: 2 }]);
  });

  it("never mixes workspaces, and skips decided or expired requests", async () => {
    rendered = [];
    await propose(outsider, "cmp-x", otherWs, otherClient, otherAccount);
    const expired = await propose(analyst, "cmp-4");
    await exec.query("update approval_requests set expires_at = now() - interval '1 hour' where id = $1", [expired]);
    const decided = await propose(analyst, "cmp-5");
    await db.as(user(owner), (q) => q("select public.decide_approval($1, false)", [decided]));
    const mailer = new FakeMailer();
    const results = await notifyPendingApprovals(deps(mailer));
    expect(results.map((r) => r.workspaceId)).toEqual([otherWs]);
    expect(mailer.sent.map((m) => m.to)).toEqual(["outsider-n@example.test"]);
    expect(rendered.flatMap((r) => r.items.map((i) => i.workspace_id))).toEqual([otherWs]);
  });
});
