import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, anon, service, superuser, user, type Query } from "./harness.js";

/**
 * M1 GATE: a user from workspace A cannot read or change workspace B's data,
 * a client_viewer sees only their own client, platform credentials are
 * server-only, and the audit log is append-only.
 */

let db: TestDb;

// Two independent agencies, plus a client-viewer inside agency A.
let alice: string; // owner of agency A
let bob: string; // owner of agency B
let carol: string; // client_viewer of client A1 only
let wsA: string;
let wsB: string;
let clientA1: string;
let clientA2: string;
let clientB1: string;

/** First row of a query; fails the test loudly if there is none. */
const one = async (q: Query, sql: string, params?: unknown[]) => {
  const row = (await q(sql, params))[0];
  if (!row) throw new Error(`expected a row from: ${sql}`);
  return row;
};

beforeAll(async () => {
  db = await TestDb.create();
  alice = await db.createUser("owner-a@example.test");
  bob = await db.createUser("owner-b@example.test");
  carol = await db.createUser("viewer-a1@example.test");

  wsA = (await db.as(user(alice), (q) => one(q, "select public.create_workspace('Test Agency A', 'agency') as id"))).id;
  wsB = (await db.as(user(bob), (q) => one(q, "select public.create_workspace('Test Agency B', 'agency') as id"))).id;

  await db.as(user(alice), async (q) => {
    clientA1 = (await one(q, "insert into clients (workspace_id, name) values ($1, 'Test Client A1') returning id", [wsA])).id;
    clientA2 = (await one(q, "insert into clients (workspace_id, name) values ($1, 'Test Client A2') returning id", [wsA])).id;
    for (const [cid, ext] of [[clientA1, "tt-a1"], [clientA2, "tt-a2"]]) {
      await q("insert into ad_accounts (workspace_id, client_id, platform, external_id) values ($1, $2, 'tiktok', $3)", [wsA, cid, ext]);
    }
    await q("insert into memberships (workspace_id, user_id, role, client_id) values ($1, $2, 'client_viewer', $3)", [wsA, carol, clientA1]);
    await q("insert into approval_requests (workspace_id, client_id, kind, requested_by) values ($1, $2, 'campaign.launch', $3)", [wsA, clientA1, alice]);
  });

  await db.as(user(bob), async (q) => {
    clientB1 = (await one(q, "insert into clients (workspace_id, name) values ($1, 'Test Client B1') returning id", [wsB])).id;
    await q("insert into ad_accounts (workspace_id, client_id, platform, external_id) values ($1, $2, 'tiktok', 'tt-b1')", [wsB, clientB1]);
    await q("insert into approval_requests (workspace_id, client_id, kind, requested_by) values ($1, $2, 'campaign.launch', $3)", [wsB, clientB1, bob]);
  });

  // Credentials are written by the server only.
  await db.as(service, async (q) => {
    const accounts = await q("select id, workspace_id from ad_accounts");
    for (const a of accounts) {
      await q("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, $3)", [
        a.id, a.workspace_id, `secret://test/${a.id}`,
      ]);
    }
  });
});

afterAll(async () => {
  await db?.destroy();
});

describe("cross-workspace isolation (M1 gate)", () => {
  it("every table in public has row-level security enabled", async () => {
    const rows = await db.as(superuser, (q) =>
      q(`select c.relname, c.relrowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("user A sees zero rows of workspace B in EVERY table that has workspace_id", async () => {
    // Discovered dynamically, so tables added in later migrations are covered
    // automatically.
    const tables = await db.as(superuser, (q) =>
      q(`select table_name from information_schema.columns
         where table_schema = 'public' and column_name = 'workspace_id'`),
    );
    expect(tables.length).toBeGreaterThanOrEqual(6);
    for (const { table_name } of tables) {
      // Sanity: workspace B really has rows here, otherwise the check proves nothing.
      const total = await db.as(superuser, (q) => one(q, `select count(*)::int as n from public.${table_name} where workspace_id = $1`, [wsB]));
      const seen = await db.as(user(alice), async (q) => {
        try {
          return (await one(q, `select count(*)::int as n from public.${table_name} where workspace_id = $1`, [wsB])).n;
        } catch (e: any) {
          if (e.code === "42501") return 0; // no privilege at all is also "cannot read"
          throw e;
        }
      });
      expect({ table: table_name, seen }).toEqual({ table: table_name, seen: 0 });
      expect(total.n, `seed data missing for ${table_name}`).toBeGreaterThan(0);
    }
  });

  it("user A only sees their own workspace, clients and ad accounts", async () => {
    await db.as(user(alice), async (q) => {
      expect((await q("select id from workspaces")).map((r) => r.id)).toEqual([wsA]);
      expect((await q("select id from clients order by name")).map((r) => r.id)).toEqual([clientA1, clientA2]);
      expect((await q("select distinct workspace_id from ad_accounts")).map((r) => r.workspace_id)).toEqual([wsA]);
    });
  });

  it("user A cannot create, change or delete anything in workspace B", async () => {
    await expect(
      db.as(user(alice), (q) => q("insert into clients (workspace_id, name) values ($1, 'Intruder')", [wsB])),
    ).rejects.toThrow(/row-level security/);

    await expect(
      db.as(user(alice), (q) =>
        q("insert into ad_accounts (workspace_id, client_id, platform, external_id) values ($1, $2, 'tiktok', 'x')", [wsB, clientB1]),
      ),
    ).rejects.toThrow(/row-level security/);

    const updated = await db.as(user(alice), (q) => q("update clients set name = 'Hacked' where id = $1 returning id", [clientB1]));
    const deleted = await db.as(user(alice), (q) => q("delete from ad_accounts where workspace_id = $1 returning id", [wsB]));
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);

    const name = await db.as(superuser, (q) => one(q, "select name from clients where id = $1", [clientB1]));
    expect(name.name).toBe("Test Client B1");
  });

  it("user A cannot join workspace B or point their own rows at B's clients", async () => {
    await expect(
      db.as(user(alice), (q) => q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [wsB, alice])),
    ).rejects.toThrow(/row-level security/);

    // Composite foreign key: an A ad account can never reference a B client.
    await expect(
      db.as(user(alice), (q) =>
        q("insert into ad_accounts (workspace_id, client_id, platform, external_id) values ($1, $2, 'tiktok', 'y')", [wsA, clientB1]),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("client_viewer", () => {
  it("sees only their own client and its ad accounts", async () => {
    await db.as(user(carol), async (q) => {
      expect((await q("select id from clients")).map((r) => r.id)).toEqual([clientA1]);
      const accounts = await q("select client_id from ad_accounts");
      expect(accounts.map((r) => r.client_id)).toEqual([clientA1]);
      expect((await q("select client_id from approval_requests")).map((r) => r.client_id)).toEqual([clientA1]);
    });
  });

  it("cannot read the audit log, the team list, or create clients", async () => {
    await db.as(user(carol), async (q) => {
      expect(await q("select id from audit_log")).toEqual([]);
      expect((await q("select user_id from memberships")).map((r) => r.user_id)).toEqual([carol]);
    });
    await expect(
      db.as(user(carol), (q) => q("insert into clients (workspace_id, name) values ($1, 'Nope')", [wsA])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("roles and credentials", () => {
  it("an owner cannot change their own role", async () => {
    const rows = await db.as(user(alice), (q) =>
      q("update memberships set role = 'analyst' where user_id = $1 returning user_id", [alice]),
    );
    expect(rows).toEqual([]);
  });

  it("platform credentials are invisible to every signed-in user, even the owner", async () => {
    await expect(db.as(user(alice), (q) => q("select * from ad_account_credentials"))).rejects.toThrow(/permission denied/);
    const row = await db.as(service, (q) => one(q, "select count(*)::int as n from ad_account_credentials"));
    expect(row.n).toBe(3);
  });

  it("the anonymous role can read nothing", async () => {
    for (const t of ["workspaces", "clients", "memberships", "ad_accounts", "approval_requests", "audit_log"]) {
      await expect(db.as(anon, (q) => q(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
    }
  });

  it("only signed-in users can create a workspace", async () => {
    await expect(db.as(anon, (q) => q("select public.create_workspace('X', 'agency')"))).rejects.toThrow(/permission denied/);
  });

  it("a business workspace gets its own client record automatically", async () => {
    const dana = await db.createUser("owner-shop@example.test");
    const ws = await db.as(user(dana), (q) => one(q, "select public.create_workspace('Test Shop', 'business') as id"));
    const clients = await db.as(user(dana), (q) => q("select workspace_id, name from clients"));
    expect(clients).toEqual([{ workspace_id: ws.id, name: "Test Shop" }]);
  });
});

describe("audit log is append-only", () => {
  it("records workspace creation", async () => {
    const rows = await db.as(user(alice), (q) => q("select action from audit_log where workspace_id = $1", [wsA]));
    expect(rows.map((r) => r.action)).toContain("workspace.created");
  });

  it("blocks UPDATE, DELETE and TRUNCATE, even for the server and the database superuser", async () => {
    // The server role isn't even granted these; the superuser is, and is
    // still stopped by the trigger.
    for (const [actor, reason] of [[service, /permission denied|append-only/], [superuser, /append-only/]] as const) {
      await expect(db.as(actor, (q) => q("update audit_log set action = 'tampered'"))).rejects.toThrow(reason);
      await expect(db.as(actor, (q) => q("delete from audit_log"))).rejects.toThrow(reason);
      await expect(db.as(actor, (q) => q("truncate audit_log"))).rejects.toThrow(reason);
    }
  });

  it("the server can append to the audit log", async () => {
    await db.as(service, (q) =>
      q("insert into audit_log (workspace_id, actor_kind, actor_label, action) values ($1, 'agent', 'test-agent', 'test.event')", [wsA]),
    );
  });

  it("users cannot write entries in someone else's name or another workspace", async () => {
    await expect(
      db.as(user(alice), (q) =>
        q("insert into audit_log (workspace_id, actor_kind, actor_user_id, action) values ($1, 'user', $2, 'fake')", [wsA, bob]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.as(user(alice), (q) =>
        q("insert into audit_log (workspace_id, actor_kind, actor_user_id, action) values ($1, 'user', $2, 'fake')", [wsB, alice]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
