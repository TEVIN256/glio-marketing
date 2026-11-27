import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestDb, service, user } from "@glio/db/test-harness";
import { type FetchLike, type RedactedOrder, ZidConnector } from "@glio/connectors";
import {
  InMemorySecretStore, type SqlExecutor, aggregateStoreDay, connectStore, deleteClientData, disconnectStore,
  newSecretRef, refreshStoreTokensIfDue, syncStoreSales,
} from "../src/index.ts";
import { zidOrder } from "../../connectors/test/fixtures/zid-orders.ts";

const o = (id: string, over: Partial<RedactedOrder> = {}): RedactedOrder => ({
  id, created_at: "2026-01-01 10:00:00", status: "new", payment_status: "paid", order_total: "100.00", currency_code: "SAR", source: "Store", ...over,
});

describe("store day figures", () => {
  it("counts sales, leaves out cancelled and voided, deducts full refunds, flags partial ones", () => {
    const f = aggregateStoreDay([
      o("1"),
      o("2", { order_total: "50.25", payment_status: "pending" }), // cash on delivery: still a sale
      o("3", { status: "canceled" }),
      o("4", { payment_status: "voided" }),
      o("5", { payment_status: "refunded", order_total: "20.00" }),
      o("6", { status: "reversed", order_total: "10.00" }),
      o("7", { status: "partially_reversed", order_total: "30.00" }),
    ], "SAR");
    expect(f).toEqual({
      currency: "SAR", orders: 5, grossMinor: 21025n, cancelledOrders: 2, refundedOrders: 2, refundedMinor: 3000n,
      partiallyRefundedOrders: 1, netMinor: 18025n,
    });
  });

  it("refuses to guess: mixed currency or a missing total is an error; an empty day is zero", () => {
    expect(() => aggregateStoreDay([o("1"), o("2", { currency_code: "USD" })], "SAR")).toThrow(/USD/);
    expect(() => aggregateStoreDay([o("1", { order_total: null })], "SAR")).toThrow(/no total/);
    expect(() => aggregateStoreDay([o("1", { order_total: "1.005" })], "SAR")).toThrow(/precision/);
    expect(aggregateStoreDay([], "SAR")).toMatchObject({ orders: 0, grossMinor: 0n, netMinor: 0n });
    expect(aggregateStoreDay([], null)).toBeNull();
  });
});

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let wsId: string;
let clientId: string;
let otherClientId: string;
const secrets = new InMemorySecretStore();
let ordersByDay: Record<string, unknown[]>;
let calls: string[];
let status: number;
const fetch: FetchLike = async (url, init) => {
  calls.push(url);
  if (JSON.stringify(init?.headers ?? {}).includes("Bearer auth-1") === false) return { status: 401, json: async () => ({}) };
  if (status !== 200) return { status, json: async () => ({}) };
  const day = (new URL(url).searchParams.get("date_from") ?? "").slice(0, 10);
  const list = ordersByDay[day] ?? [];
  return { status: 200, json: async () => ({ status: "object", orders: list, total_order_count: list.length }) };
};
const deps = () => ({ db: exec, secrets, connector: new ZidConnector({ fetch }), retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} } });
const tokens = { authorization: "auth-1", managerToken: "mgr-1", refreshToken: "refresh-1", expiresIn: 94608000 };
const store = { externalId: "test-store-1", name: "Test Store", timezone: "Asia/Riyadh", currency: "SAR" };

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (text, params) => db.as(service, (q) => q(text, params)), transaction: (fn) => db.as(service, fn) };
  owner = await db.createUser("store-owner@example.test");
  wsId = (await db.as(user(owner), async (q) => (await q("select public.create_workspace('Test Agency Store', 'agency') as id"))[0]!)).id;
  await db.as(user(owner), async (q) => {
    clientId = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client Z1') returning id", [wsId]))[0]!.id;
    otherClientId = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client Z2') returning id", [wsId]))[0]!.id;
  });
});
beforeEach(() => {
  calls = [];
  status = 200;
  ordersByDay = {
    "2026-01-01": [zidOrder(1), zidOrder(2, { order_total: "250.50" }), zidOrder(3, { order_status: { name: "x", code: "canceled" } })],
    "2026-01-02": [zidOrder(4, { payment_status: "refunded", order_total: "40.00" }), zidOrder(5)],
  };
});
afterAll(async () => {
  await db?.destroy();
});

describe("Zid store connection and sync", () => {
  let connectionId: string;

  it("connects: tokens only in the secret store, the table keeps a reference; audited", async () => {
    const ref = newSecretRef("zid");
    const r = await connectStore({ db: exec, secrets }, { workspaceId: wsId, clientId, userId: owner, platform: "zid", store, tokens, secretRef: ref });
    connectionId = r.connectionId;
    expect(r.reconnected).toBe(false);
    expect(secrets.has(ref)).toBe(true);
    const dump = JSON.stringify(await exec.query("select * from store_connections s join store_credentials c on c.connection_id = s.id"));
    expect(dump).not.toContain("auth-1");
    expect(dump).not.toContain("refresh-1");
    const [a] = await exec.query("select action, metadata from audit_log where action = 'store.connected'");
    expect(a!.metadata).toMatchObject({ external_store_id: "test-store-1", client_id: clientId });
  });

  it("refuses to attach the same store to a second client", async () => {
    await expect(connectStore({ db: exec, secrets }, {
      workspaceId: wsId, clientId: otherClientId, userId: owner, platform: "zid", store, tokens, secretRef: newSecretRef("zid"),
    })).rejects.toMatchObject({ code: "STORE_CONNECTED_ELSEWHERE" });
  });

  it("syncs each day with Riyadh boundaries; stores no personal data; re-running changes nothing", async () => {
    expect(await syncStoreSales(deps(), { connectionId, dateFrom: "2026-01-01", dateTo: "2026-01-02" })).toEqual({ days: 2, orders: 4 });
    expect(new URL(calls[0]!).searchParams.get("date_from")).toBe("2026-01-01T00:00:00.000+0300");
    const rows = await exec.query(
      `select date::text, orders, gross_sales_minor::text as gross, cancelled_orders, refunded_minor::text as refunded, net_sales_minor::text as net
       from store_sales_daily where connection_id = $1 order by date`, [connectionId]);
    expect(rows).toEqual([
      { date: "2026-01-01", orders: 2, gross: "35050", cancelled_orders: 1, refunded: "0", net: "35050" },
      { date: "2026-01-02", orders: 2, gross: "14000", cancelled_orders: 0, refunded: "4000", net: "10000" },
    ]);
    const payloads = JSON.stringify(await exec.query("select payload from store_payloads"));
    for (const personal of ["Test Customer", "customer@example.test", "966500000000", "Test Street"]) expect(payloads).not.toContain(personal);

    const before = JSON.stringify(await exec.query("select * from store_sales_daily order by date"));
    const nPayloads = (await exec.query("select count(*)::int as n from store_payloads"))[0]!.n;
    await syncStoreSales(deps(), { connectionId, dateFrom: "2026-01-01", dateTo: "2026-01-02" });
    expect(JSON.stringify(await exec.query("select * from store_sales_daily order by date"))).toBe(before);
    expect((await exec.query("select count(*)::int as n from store_payloads"))[0]!.n).toBe(nPayloads);
  });

  it("a later cancellation updates the day on the next sync", async () => {
    ordersByDay["2026-01-01"] = [zidOrder(1), zidOrder(2, { order_total: "250.50", order_status: { name: "x", code: "cancelled" } })];
    await syncStoreSales(deps(), { connectionId, dateFrom: "2026-01-01", dateTo: "2026-01-01" });
    const [r] = await exec.query("select orders, net_sales_minor::text as net from store_sales_daily where connection_id = $1 and date = '2026-01-01'", [connectionId]);
    expect(r).toEqual({ orders: 1, net: "10000" });
  });

  it("a refused sign-in marks the store as needing to reconnect, and writes nothing", async () => {
    status = 401;
    await expect(syncStoreSales(deps(), { connectionId, dateFrom: "2026-01-03", dateTo: "2026-01-03" })).rejects.toMatchObject({ code: "ZID_UNAUTHORIZED" });
    const [c] = await exec.query("select status, last_error_code from store_connections where id = $1", [connectionId]);
    expect(c).toEqual({ status: "needs_reauth", last_error_code: "ZID_UNAUTHORIZED" });
    expect((await exec.query("select count(*)::int as n from store_sales_daily where date = '2026-01-03'"))[0]!.n).toBe(0);
    status = 200;
    await syncStoreSales(deps(), { connectionId, dateFrom: "2026-01-03", dateTo: "2026-01-03" });
    expect((await exec.query("select status from store_connections where id = $1", [connectionId]))[0]!.status).toBe("active");
  });

  it("refreshes tokens only when due, and replaces the whole set", async () => {
    const refresh = async (rt: string) => {
      expect(rt).toBe("refresh-1");
      return { authorization: "auth-1", managerToken: "mgr-2", refreshToken: "refresh-2", expiresIn: 1000 };
    };
    expect(await refreshStoreTokensIfDue({ db: exec, secrets, refresh }, { connectionId })).toBe("not_due");
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await refreshStoreTokensIfDue({ db: exec, secrets, refresh }, { connectionId, now: later })).toBe("refreshed");
    const [{ secret_ref }] = (await exec.query("select secret_ref from store_credentials where connection_id = $1", [connectionId])) as [{ secret_ref: string }];
    expect(JSON.parse(await secrets.get(secret_ref))).toEqual({ authorization: "auth-1", managerToken: "mgr-2", refreshToken: "refresh-2" });
  });

  it("disconnecting removes the store's sales and its tokens; audited", async () => {
    const [{ secret_ref }] = (await exec.query("select secret_ref from store_credentials where connection_id = $1", [connectionId])) as [{ secret_ref: string }];
    expect(await disconnectStore({ db: exec, secrets }, { workspaceId: wsId, clientId, connectionId, userId: owner })).toBe(true);
    expect(secrets.has(secret_ref)).toBe(false);
    expect((await exec.query("select count(*)::int as n from store_sales_daily where connection_id = $1", [connectionId]))[0]!.n).toBe(0);
    expect((await exec.query("select count(*)::int as n from audit_log where action = 'store.disconnected'"))[0]!.n).toBe(1);
  });

  it("deleting a client also deletes its store tokens, and never sends them to the ad platform's revoke", async () => {
    const ref = newSecretRef("zid");
    await connectStore({ db: exec, secrets }, { workspaceId: wsId, clientId: otherClientId, userId: owner, platform: "zid", store, tokens, secretRef: ref });
    const revoked: string[] = [];
    await deleteClientData({ db: exec, secrets, revoke: async (t) => { revoked.push(t); } }, { workspaceId: wsId, clientId: otherClientId, deletedBy: owner });
    expect(secrets.has(ref)).toBe(false);
    expect(revoked).toEqual([]);
  });
});
