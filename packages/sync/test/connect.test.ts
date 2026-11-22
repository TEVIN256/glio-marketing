import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, superuser, user } from "@glio/db/test-harness";
import {
  type AuthorizedAccount, InMemorySecretStore, type SqlExecutor, VaultSecretStore, connectAdAccounts, newSecretRef,
} from "../src/index.ts";

/**
 * Connecting TikTok: tokens live only in the secret store (Vault in
 * production), accounts attach to exactly one client, every connection is
 * audited, and another workspace never sees the accounts.
 */

const TOKEN_1 = "test-tiktok-token-one-must-never-be-in-tables";
const TOKEN_2 = "test-tiktok-token-two-must-never-be-in-tables";
const A1: AuthorizedAccount = { externalId: "7000000000000000001", name: "Test Client A1", currency: "SAR", timezone: "Asia/Riyadh" };
const A2: AuthorizedAccount = { externalId: "7000000000000000002", name: "Test Client A2", currency: null, timezone: null };

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let outsider: string;
let ws: string;
let clientA: string;
let clientB: string;

beforeAll(async () => {
  db = await TestDb.create();
  await db.as(superuser, (q) => q(readFileSync(new URL("./vault-shim.sql", import.meta.url), "utf8")));
  exec = {
    query: (text, params) => db.as({ kind: "service" }, (q) => q(text, params)),
    transaction: (fn) => db.as({ kind: "service" }, fn),
  };
  owner = await db.createUser("owner@example.test");
  outsider = await db.createUser("outsider@example.test");
  ws = (await db.as(user(owner), (q) => q("select public.create_workspace('Test Agency A', 'agency') as id")))[0]!.id;
  await db.as(user(outsider), (q) => q("select public.create_workspace('Test Agency B', 'agency')"));
  [clientA, clientB] = await db.as(superuser, async (q) => [
    (await q("insert into public.clients (workspace_id, name) values ($1, 'Test Client A1') returning id", [ws]))[0]!.id,
    (await q("insert into public.clients (workspace_id, name) values ($1, 'Test Client B1') returning id", [ws]))[0]!.id,
  ]);
});

afterAll(async () => db?.destroy());

const args = (overrides: Partial<Parameters<typeof connectAdAccounts>[1]> = {}) => ({
  workspaceId: ws, clientId: clientA, userId: owner, platform: "tiktok" as const,
  accessToken: TOKEN_1, secretRef: newSecretRef("tiktok"), accounts: [A1, A2], scopes: ["reporting"], ...overrides,
});

describe("VaultSecretStore", () => {
  it("stores, updates, reads and deletes by ref", async () => {
    const store = new VaultSecretStore(exec);
    const ref = newSecretRef("tiktok");
    expect(ref).toMatch(/^vault:glio\/tiktok\/[0-9a-f-]{36}$/);
    await store.put(ref, "v1");
    expect(await store.get(ref)).toBe("v1");
    await store.put(ref, "v2");
    expect(await store.get(ref)).toBe("v2");
    await store.delete(ref);
    await expect(store.get(ref)).rejects.toThrow(/No secret stored/);
    await expect(store.get("demo://synthetic")).rejects.toThrow(/Not a Vault secret ref/);
  });
});

describe("connectAdAccounts", () => {
  it("attaches the authorised accounts to the client, active, with only a secret reference stored", async () => {
    const store = new VaultSecretStore(exec);
    const a = args();
    const res = await connectAdAccounts({ db: exec, secrets: store }, a);
    expect(res.conflicts).toEqual([]);
    expect(res.connected.map((c) => [c.externalId, c.reconnected])).toEqual([[A1.externalId, false], [A2.externalId, false]]);

    const rows = await db.as(superuser, (q) => q(
      `select a.external_id, a.name, a.currency, a.timezone, a.status, c.secret_ref, c.scopes
       from public.ad_accounts a join public.ad_account_credentials c on c.ad_account_id = a.id
       where a.client_id = $1 order by a.external_id`, [clientA]));
    expect(rows).toEqual([
      { external_id: A1.externalId, name: "Test Client A1", currency: "SAR", timezone: "Asia/Riyadh", status: "active", secret_ref: a.secretRef, scopes: ["reporting"] },
      { external_id: A2.externalId, name: "Test Client A2", currency: null, timezone: null, status: "active", secret_ref: a.secretRef, scopes: ["reporting"] },
    ]);
    expect(await store.get(a.secretRef)).toBe(TOKEN_1);

    // The token is nowhere in the application's tables.
    const dump = await db.as(superuser, (q) => q(
      "select (select json_agg(t) from public.ad_accounts t)::text || (select json_agg(t) from public.ad_account_credentials t)::text || (select json_agg(t) from public.audit_log t)::text as all"));
    expect(dump[0]!.all).not.toContain(TOKEN_1);

    const audit = await db.as(superuser, (q) => q(
      "select action, actor_user_id, metadata->>'external_id' as ext from public.audit_log where action = 'ad_account.connected' order by id"));
    expect(audit).toEqual([
      { action: "ad_account.connected", actor_user_id: owner, ext: A1.externalId },
      { action: "ad_account.connected", actor_user_id: owner, ext: A2.externalId },
    ]);
  });

  it("reconnecting replaces the token and deletes the old one", async () => {
    const store = new VaultSecretStore(exec);
    const [before] = await db.as(superuser, (q) => q(
      "select c.secret_ref from public.ad_account_credentials c join public.ad_accounts a on a.id = c.ad_account_id where a.external_id = $1", [A1.externalId]));
    const a = args({ accessToken: TOKEN_2 });
    const res = await connectAdAccounts({ db: exec, secrets: store }, a);
    expect(res.connected.every((c) => c.reconnected)).toBe(true);
    expect(await store.get(a.secretRef)).toBe(TOKEN_2);
    await expect(store.get(before!.secret_ref)).rejects.toThrow(/No secret stored/);
    const count = await db.as(superuser, (q) => q("select count(*)::int as n from public.ad_accounts where workspace_id = $1", [ws]));
    expect(count[0]!.n).toBe(2);
  });

  it("does not move an account that belongs to another client, and stores nothing if nothing connects", async () => {
    const store = new InMemorySecretStore();
    const a = args({ clientId: clientB, accounts: [A1] });
    const res = await connectAdAccounts({ db: exec, secrets: store }, a);
    expect(res.connected).toEqual([]);
    expect(res.conflicts).toEqual([{ externalId: A1.externalId, name: A1.name }]);
    expect(store.has(a.secretRef)).toBe(false);
    const [row] = await db.as(superuser, (q) => q("select client_id from public.ad_accounts where external_id = $1", [A1.externalId]));
    expect(row!.client_id).toBe(clientA);
  });

  it("refuses a client from another workspace", async () => {
    const otherWs = (await db.as(user(outsider), (q) => q("select id from public.workspaces")))[0]!.id;
    await expect(connectAdAccounts({ db: exec, secrets: new InMemorySecretStore() }, args({ workspaceId: otherWs })))
      .rejects.toThrow(/Client not found/);
  });

  it("connected accounts are visible to the workspace's members and invisible to others (RLS)", async () => {
    const mine = await db.as(user(owner), (q) => q("select external_id from public.ad_accounts order by external_id"));
    expect(mine.map((r) => r.external_id)).toEqual([A1.externalId, A2.externalId]);
    expect(await db.as(user(outsider), (q) => q("select external_id from public.ad_accounts"))).toEqual([]);
    await expect(db.as(user(owner), (q) => q("select secret_ref from public.ad_account_credentials"))).rejects.toThrow(/permission denied/);
  });
});
