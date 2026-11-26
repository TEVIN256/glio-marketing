import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import { InMemorySecretStore, type SqlExecutor, disconnectAdAccount } from "../src/index.ts";

/**
 * Disconnecting an ad account (ADR-034): GLIO stops using it, keeps its history,
 * drops its credential, and revokes the token at TikTok only when no other
 * connected account shares that token.
 */

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let ws: string;
let client: string;
let otherClient: string;
const secrets = new InMemorySecretStore();
let revoked: string[] = [];
let revokeFails = false;
const revoke = async (token: string) => {
  if (revokeFails) throw Object.assign(new Error("TikTok error 50000"), { code: "tiktok_50000" });
  revoked.push(token);
};
const deps = () => ({ db: exec, secrets, revoke });

async function account(clientId: string, ext: string, ref: string): Promise<string> {
  const [a] = await db.as(superuser, (q) => q(
    "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency, status) values ($1, $2, 'tiktok', $3, 'SAR', 'active') returning id",
    [ws, clientId, ext]));
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, $3)", [a!.id, ws, ref]);
  return a!.id;
}
const status = async (id: string) => (await db.as(superuser, (q) => q(
  "select a.status, (select count(*)::int from ad_account_credentials c where c.ad_account_id = a.id) as creds from ad_accounts a where id = $1", [id])))[0];

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  owner = await db.createUser("owner-disc@example.test");
  ws = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency Disc', 'agency') as id")))[0]!.id;
  [client, otherClient] = await db.as(superuser, async (q) => [
    (await q("insert into clients (workspace_id, name) values ($1, 'Test Client Disc A') returning id", [ws]))[0]!.id,
    (await q("insert into clients (workspace_id, name) values ($1, 'Test Client Disc B') returning id", [ws]))[0]!.id,
  ]);
});
afterAll(async () => db?.destroy());

describe("disconnecting a TikTok ad account", () => {
  it("stops GLIO using it: status, credential, token revoked and deleted, open requests expired, audited", async () => {
    await secrets.put("secret://disc/solo", "token-solo");
    const id = await account(client, "7200000000000000001", "secret://disc/solo");
    await db.as(superuser, (q) => q(
      "insert into approval_requests (workspace_id, client_id, ad_account_id, kind, requested_by, target_type, target_id) values ($1, $2, $3, 'campaign.pause', $4, 'campaign', 'c1')",
      [ws, client, id, owner]));
    const r = await disconnectAdAccount(deps(), { workspaceId: ws, clientId: client, adAccountId: id, userId: owner });
    expect(r).toEqual({ disconnected: true, revokedAtPlatform: true, revokeError: null, expiredRequests: 1 });
    expect(await status(id)).toEqual({ status: "disconnected", creds: 0 });
    expect(revoked).toEqual(["token-solo"]);
    await expect(secrets.get("secret://disc/solo")).rejects.toThrow();
    const [a] = await db.as(superuser, (q) => q("select actor_user_id, metadata->>'token' as token from audit_log where action = 'ad_account.disconnected'"));
    expect(a).toEqual({ actor_user_id: owner, token: "revoked" });
  });

  it("a token shared with another connected account is kept and not revoked", async () => {
    revoked = [];
    await secrets.put("secret://disc/shared", "token-shared");
    const one = await account(client, "7200000000000000002", "secret://disc/shared");
    const two = await account(otherClient, "7200000000000000003", "secret://disc/shared");
    const r = await disconnectAdAccount(deps(), { workspaceId: ws, clientId: client, adAccountId: one, userId: owner });
    expect(r).toMatchObject({ disconnected: true, revokedAtPlatform: false, revokeError: null });
    expect(revoked).toEqual([]);
    expect(await secrets.get("secret://disc/shared")).toBe("token-shared");
    expect(await status(two)).toEqual({ status: "active", creds: 1 });
  });

  it("if TikTok refuses the revoke, GLIO still disconnects and deletes its copy of the token, and says so", async () => {
    revokeFails = true;
    await secrets.put("secret://disc/fail", "token-fail");
    const id = await account(client, "7200000000000000004", "secret://disc/fail");
    const r = await disconnectAdAccount(deps(), { workspaceId: ws, clientId: client, adAccountId: id, userId: owner });
    expect(r).toMatchObject({ disconnected: true, revokedAtPlatform: false, revokeError: "tiktok_50000" });
    await expect(secrets.get("secret://disc/fail")).rejects.toThrow();
    revokeFails = false;
  });

  it("an account of another client (or workspace) is not touched", async () => {
    await secrets.put("secret://disc/b", "token-b");
    const id = await account(otherClient, "7200000000000000005", "secret://disc/b");
    expect((await disconnectAdAccount(deps(), { workspaceId: ws, clientId: client, adAccountId: id, userId: owner })).disconnected).toBe(false);
    expect(await status(id)).toEqual({ status: "active", creds: 1 });
  });
});
