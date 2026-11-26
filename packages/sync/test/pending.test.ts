import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import {
  type AuthorizedAccount, type SqlExecutor, VaultSecretStore, cancelPendingConnection, confirmPendingConnection,
  createPendingConnection, deleteClientData, loadPendingConnection, purgeExpiredPendingConnections,
} from "../src/index.ts";

/**
 * Account picker (migration 0015): with several authorised ad accounts, nothing is
 * attached until the owner chooses; only chosen accounts are attached; the pending
 * choice belongs to the user who started it; tokens never linger unused.
 */

const TOKEN = "test-tiktok-token-pending-must-never-be-in-tables";
const acc = (n: number, name: string): AuthorizedAccount => ({ externalId: `710000000000000000${n}`, name, currency: "SAR", timezone: "Asia/Riyadh" });
const MINE = acc(1, "Test Advertiser Mine");
const OTHER_BUSINESS = acc(2, "Test Advertiser Other Business");
const SISTER = acc(3, "Test Advertiser Sister Client");

let db: TestDb;
let exec: SqlExecutor;
let store: VaultSecretStore;
let owner: string;
let colleague: string;
let ws: string;
let clientA: string;
let clientB: string;

const deps = () => ({ db: exec, secrets: store });
const start = (clientId = clientA, userId = owner) =>
  createPendingConnection(deps(), { workspaceId: ws, clientId, userId, platform: "tiktok", accessToken: TOKEN, accounts: [MINE, OTHER_BUSINESS, SISTER] });
const secretsLeft = async () => (await db.as(superuser, (q) => q("select count(*)::int as n from vault.secrets")))[0]!.n as number;

beforeAll(async () => {
  db = await TestDb.create();
  await db.as(superuser, (q) => q(readFileSync(new URL("./vault-shim.sql", import.meta.url), "utf8")));
  exec = { query: (t, p) => db.as({ kind: "service" }, (q) => q(t, p)), transaction: (fn) => db.as({ kind: "service" }, fn) };
  store = new VaultSecretStore(exec);
  owner = await db.createUser("owner-pick@example.test");
  colleague = await db.createUser("colleague-pick@example.test");
  ws = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency Pick', 'agency') as id")))[0]!.id;
  await db.as(user(owner), (q) => q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'manager')", [ws, colleague]));
  [clientA, clientB] = await db.as(superuser, async (q) => [
    (await q("insert into public.clients (workspace_id, name) values ($1, 'Test Client PickA') returning id", [ws]))[0]!.id,
    (await q("insert into public.clients (workspace_id, name) values ($1, 'Test Client PickB') returning id", [ws]))[0]!.id,
  ]);
  // SISTER already belongs to client B.
  await db.as(superuser, async (q) => {
    const [a] = await q("insert into ad_accounts (workspace_id, client_id, platform, external_id, status) values ($1, $2, 'tiktok', $3, 'active') returning id", [ws, clientB, SISTER.externalId]);
    await q("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'vault:glio/tiktok/existing-b')", [a!.id, ws]);
  });
});
afterAll(async () => db?.destroy());

describe("account picker", () => {
  it("nothing is attached before the choice; the token is in Vault, never in the table", async () => {
    const id = await start();
    expect(await db.as(superuser, (q) => q("select count(*)::int as n from ad_accounts where client_id = $1", [clientA]))).toEqual([{ n: 0 }]);
    const dump = await db.as(superuser, (q) => q("select row_to_json(p)::text as r from pending_ad_connections p where id = $1", [id]));
    expect(dump[0]!.r).not.toContain(TOKEN);
    const p = await loadPendingConnection(exec, { id, userId: owner });
    expect(p!.accounts.map((a) => [a.externalId, a.state, a.otherClientName])).toEqual([
      [MINE.externalId, "new", null], [OTHER_BUSINESS.externalId, "new", null], [SISTER.externalId, "other_client", "Test Client PickB"],
    ]);
  });

  it("only the chosen account is attached; the choice works once and only for the user who started it", async () => {
    const id = await start();
    expect(await loadPendingConnection(exec, { id, userId: colleague })).toBeNull();
    expect(await confirmPendingConnection(deps(), { id, userId: colleague, externalIds: [MINE.externalId] })).toBeNull();
    const r = await confirmPendingConnection(deps(), { id, userId: owner, externalIds: [MINE.externalId] });
    expect(r!.connected.map((c) => c.externalId)).toEqual([MINE.externalId]);
    const attached = await db.as(superuser, (q) => q("select external_id from ad_accounts where client_id = $1", [clientA]));
    expect(attached.map((x) => x.external_id)).toEqual([MINE.externalId]);
    expect(await confirmPendingConnection(deps(), { id, userId: owner, externalIds: [OTHER_BUSINESS.externalId] })).toBeNull();
  });

  it("an account TikTok didn't authorise can't be slipped in; nothing is attached and the token is dropped", async () => {
    const before = await secretsLeft();
    const id = await start();
    await expect(confirmPendingConnection(deps(), { id, userId: owner, externalIds: [MINE.externalId, "7999999999999999999"] }))
      .rejects.toMatchObject({ code: "ACCOUNT_NOT_AUTHORISED" });
    expect(await secretsLeft()).toBe(before);
  });

  it("cancel, choosing none, and expiry all leave no token behind", async () => {
    const before = await secretsLeft();
    const a = await start();
    expect(await cancelPendingConnection(deps(), { id: a, userId: owner })).toBe(true);
    const b = await start();
    expect((await confirmPendingConnection(deps(), { id: b, userId: owner, externalIds: [] }))!.connected).toEqual([]);
    const c = await start();
    await db.as(superuser, (q) => q("update pending_ad_connections set expires_at = now() - interval '1 minute' where id = $1", [c]));
    expect(await loadPendingConnection(exec, { id: c, userId: owner })).toBeNull();
    expect(await purgeExpiredPendingConnections(deps())).toBe(1);
    expect(await secretsLeft()).toBe(before);
  });

  it("users can't read pending connections at all; deleting the client removes its pending token too", async () => {
    await start();
    await expect(db.as(user(owner), (q) => q("select * from pending_ad_connections"))).rejects.toThrow(/permission denied/);
    const before = await secretsLeft();
    const id = await start(clientB);
    expect(await secretsLeft()).toBe(before + 1);
    await deleteClientData(deps(), { workspaceId: ws, clientId: clientB, deletedBy: owner });
    expect(await db.as(superuser, (q) => q("select count(*)::int as n from pending_ad_connections where id = $1", [id]))).toEqual([{ n: 0 }]);
  });
});
