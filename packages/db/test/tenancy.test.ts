import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, anon, service, superuser, user, type Query } from "./harness.ts";

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
    for (const cid of [clientA1, clientA2]) {
      await q("insert into report_schedules (workspace_id, client_id, frequency, recipients) values ($1, $2, 'weekly', '{reports-a@example.test}')", [wsA, cid]);
      await q("insert into client_guardrails (workspace_id, client_id, max_daily_budget_minor) values ($1, $2, 50000)", [wsA, cid]);
    }
    await q("insert into notification_settings (workspace_id, user_id, approvals_email) values ($1, $2, true)", [wsA, alice]);
  });

  await db.as(user(bob), async (q) => {
    clientB1 = (await one(q, "insert into clients (workspace_id, name) values ($1, 'Test Client B1') returning id", [wsB])).id;
    await q("insert into ad_accounts (workspace_id, client_id, platform, external_id) values ($1, $2, 'tiktok', 'tt-b1')", [wsB, clientB1]);
    await q("insert into approval_requests (workspace_id, client_id, kind, requested_by) values ($1, $2, 'campaign.launch', $3)", [wsB, clientB1, bob]);
    await q("insert into report_schedules (workspace_id, client_id, frequency, recipients) values ($1, $2, 'weekly', '{reports-b@example.test}')", [wsB, clientB1]);
    await q("insert into client_guardrails (workspace_id, client_id) values ($1, $2)", [wsB, clientB1]);
    await q("insert into notification_settings (workspace_id, user_id, approvals_email) values ($1, $2, false)", [wsB, bob]);
  });

  // Credentials, sync runs, raw payloads and metrics are written by the server only.
  await db.as(service, async (q) => {
    const accounts = await q("select id, workspace_id, client_id from ad_accounts");
    for (const a of accounts) {
      await q("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, $3)", [
        a.id, a.workspace_id, `secret://test/${a.id}`,
      ]);
      const run = await one(q,
        `insert into sync_runs (workspace_id, client_id, ad_account_id, platform, kind, date_from, date_to, status)
         values ($1, $2, $3, 'tiktok', 'manual', '2026-01-01', '2026-01-01', 'succeeded') returning id`,
        [a.workspace_id, a.client_id, a.id]);
      const raw = await one(q,
        `insert into raw_platform_payloads (workspace_id, client_id, ad_account_id, platform, endpoint, request_params, payload, payload_sha256, first_sync_run_id)
         values ($1, $2, $3, 'tiktok', '/test/', '{}', '{"test": true}', repeat('a', 64), $4) returning id`,
        [a.workspace_id, a.client_id, a.id, run.id]);
      await q(
        `insert into metric_daily (workspace_id, client_id, ad_account_id, platform, level, entity_id, date, currency, spend_minor, raw_payload_id, sync_run_id)
         values ($1, $2, $3, 'tiktok', 'campaign', 'test-campaign', '2026-01-01', 'SAR', 100, $4, $5)`,
        [a.workspace_id, a.client_id, a.id, raw.id, run.id]);
      await q(
        `insert into reconciliation_checks (check_id, workspace_id, client_id, ad_account_id, platform, sync_run_id, date_from, date_to,
                                            metric, unit, currency, ours, theirs, drift_ppm, threshold_ppm, status, platform_payload_id)
         values (gen_random_uuid(), $1, $2, $3, 'tiktok', $4, '2026-01-01', '2026-01-01', 'spend', 'minor_units', 'SAR', 100, 100, 0, 5000, 'ok', $5)`,
        [a.workspace_id, a.client_id, a.id, run.id, raw.id]);
      const comm = await one(q,
        `insert into ai_commentary (workspace_id, client_id, input, input_sha256, prompt_version, system_prompt_sha256, source, text_ar, text_en, attempts)
         values ($1, $2, '{}', repeat('b', 64), 'test', repeat('c', 64), 'template', 'نص', 'text', '[]') returning id`,
        [a.workspace_id, a.client_id]);
      const snap = await one(q,
        `insert into report_snapshots (workspace_id, client_id, date_from, date_to, report, report_sha256, commentary_id, created_by_label)
         values ($1, $2, '2026-01-01', '2026-01-01', '{}', repeat('d', 64), $3, 'test') returning id`,
        [a.workspace_id, a.client_id, comm.id]);
      await q(
        `insert into report_deliveries (workspace_id, client_id, snapshot_id, period_from, period_to, recipient, trigger, status, provider_message_id)
         values ($1, $2, $3, '2026-01-01', '2026-01-01', 'reports@example.test', 'schedule', 'sent', 'test-message')`,
        [a.workspace_id, a.client_id, snap.id]);
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
    expect(tables.length).toBeGreaterThanOrEqual(17); // 16 tables + the reconciliation_latest view
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
      expect((await q("select distinct client_id from metric_daily")).map((r) => r.client_id)).toEqual([clientA1]);
      expect((await q("select distinct client_id from raw_platform_payloads")).map((r) => r.client_id)).toEqual([clientA1]);
      expect((await q("select distinct client_id from reconciliation_latest")).map((r) => r.client_id)).toEqual([clientA1]);
      expect((await q("select distinct client_id from report_snapshots")).map((r) => r.client_id)).toEqual([clientA1]);
      expect((await q("select distinct client_id from ai_commentary")).map((r) => r.client_id)).toEqual([clientA1]);
      expect((await q("select client_id from report_schedules")).map((r) => r.client_id)).toEqual([clientA1]);
      expect((await q("select distinct client_id from report_deliveries")).map((r) => r.client_id)).toEqual([clientA1]);
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
    expect(row.n).toBe(3); // one per seeded ad account
  });

  it("the anonymous role can read nothing", async () => {
    for (const t of ["workspaces", "clients", "memberships", "ad_accounts", "approval_requests", "audit_log",
                     "sync_runs", "raw_platform_payloads", "metric_daily", "reconciliation_checks", "reconciliation_latest",
                     "ai_commentary", "report_snapshots"]) {
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

describe("emailed reports (migration 0006)", () => {
  it("a client_viewer can read the schedule but not change it; owners can", async () => {
    await expect(db.as(user(carol), (q) =>
      q("update report_schedules set recipients = '{x@example.test}' where client_id = $1 returning client_id", [clientA1]),
    )).resolves.toEqual([]);
    const [row] = await db.as(user(alice), (q) =>
      q("update report_schedules set frequency = 'monthly' where client_id = $1 returning frequency", [clientA1]));
    expect(row!.frequency).toBe("monthly");
  });

  it("rejects recipients that aren't email addresses, and more than 20", async () => {
    await expect(db.as(user(alice), (q) =>
      q("update report_schedules set recipients = '{not-an-email}' where client_id = $1", [clientA1]),
    )).rejects.toThrow(/check constraint/);
    const many = Array.from({ length: 21 }, (_, i) => `r${i}@example.test`);
    await expect(db.as(user(alice), (q) =>
      q("update report_schedules set recipients = $2 where client_id = $1", [clientA1, many]),
    )).rejects.toThrow(/check constraint/);
  });

  it("users cannot write the delivery log; the server cannot change it", async () => {
    await expect(db.as(user(alice), (q) =>
      q(`insert into report_deliveries (workspace_id, client_id, period_from, period_to, recipient, trigger, status)
         values ($1, $2, '2026-01-01', '2026-01-01', 'a@example.test', 'manual', 'failed')`, [wsA, clientA1]),
    )).rejects.toThrow(/permission denied/);
    await expect(db.as(service, (q) => q("update report_deliveries set status = 'failed'"))).rejects.toThrow();
    await expect(db.as(service, (q) => q("delete from report_deliveries"))).rejects.toThrow();
  });

  it("a scheduled report is logged as sent at most once per client, period and recipient", async () => {
    await expect(db.as(service, async (q) => {
      const [d] = await q("select workspace_id, client_id, snapshot_id from report_deliveries where client_id = $1 limit 1", [clientA1]);
      await q(
        `insert into report_deliveries (workspace_id, client_id, snapshot_id, period_from, period_to, recipient, trigger, status, provider_message_id)
         values ($1, $2, $3, '2026-01-01', '2026-01-01', 'reports@example.test', 'schedule', 'sent', 'dup')`,
        [d!.workspace_id, d!.client_id, d!.snapshot_id]);
    })).rejects.toThrow(/duplicate key/);
  });
});

describe("approvals (migration 0007)", () => {
  const propose = (q: (t: string, p?: unknown[]) => Promise<Record<string, any>[]>, by: string, extra = "") =>
    q(`insert into approval_requests (workspace_id, client_id, kind, requested_by, ad_account_id, target_type, target_id, payload${extra ? ", " + extra.split("=")[0] : ""})
       select $1, $2, 'campaign.budget', $3, a.id, 'campaign', 'cmp-1', '{"budget_minor": "20000"}'${extra ? ", " + extra.split("=")[1] : ""}
       from ad_accounts a where a.client_id = $2 returning id`, [wsA, clientA1, by]);

  it("users propose only as themselves, pending, without execution fields", async () => {
    const [row] = await db.as(user(alice), (q) => propose(q, alice));
    expect(row!.id).toBeTruthy();
    await expect(db.as(user(alice), (q) => propose(q, alice, "before_state='{}'"))).rejects.toThrow(/row-level security/);
    await expect(db.as(user(carol), (q) => propose(q, carol))).rejects.toThrow(/row-level security/);
  });

  it("nobody updates requests directly; decisions go through decide_approval (owners/managers, audited)", async () => {
    const [row] = await db.as(user(alice), (q) => propose(q, alice));
    await expect(db.as(user(alice), (q) => q("update approval_requests set status = 'executed' where id = $1", [row!.id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(user(carol), (q) => q("select public.decide_approval($1, true)", [row!.id]))).rejects.toThrow(/only owners and managers/);
    await expect(db.as(user(bob), (q) => q("select public.decide_approval($1, true)", [row!.id]))).rejects.toThrow(/not found/);
    const [d] = await db.as(user(alice), (q) => q("select public.decide_approval($1, true, 'ok') as r", [row!.id]));
    expect(d!.r).toBe("approved");
    await expect(db.as(user(alice), (q) => q("select public.decide_approval($1, false)", [row!.id]))).rejects.toThrow(/is approved/);
    const audit = await db.as(superuser, (q) => q("select action from audit_log where entity_id = $1", [String(row!.id)]));
    expect(audit.map((a) => a.action)).toEqual(["approval.approved"]);
  });

  it("an expired request can't be approved", async () => {
    const [row] = await db.as(user(alice), (q) => propose(q, alice, "expires_at=now() - interval '1 hour'"));
    const [d] = await db.as(user(alice), (q) => q("select public.decide_approval($1, true) as r", [row!.id]));
    expect(d!.r).toBe("expired");
  });

  it("budget changes need a positive whole number of minor units", async () => {
    await expect(db.as(user(alice), (q) => q(
      `insert into approval_requests (workspace_id, client_id, kind, requested_by, ad_account_id, target_type, target_id, payload)
       select $1, $2, 'campaign.budget', $3, a.id, 'campaign', 'cmp-1', '{"budget_minor": "-5"}' from ad_accounts a where a.client_id = $2`,
      [wsA, clientA1, alice]))).rejects.toThrow(/check constraint/);
  });

  it("guardrails: everyone on the client reads them, only owners change them", async () => {
    expect(await db.as(user(carol), (q) => q("select max_daily_budget_minor::text as m from client_guardrails"))).toEqual([{ m: "50000" }]);
    expect(await db.as(user(carol), (q) => q("update client_guardrails set max_budget_increase_pct = 999 returning client_id"))).toEqual([]);
  });
});

describe("notifications (migration 0008)", () => {
  it("each person sees and edits only their own settings", async () => {
    expect(await db.as(user(carol), (q) => q("select user_id from notification_settings"))).toEqual([]);
    await expect(db.as(user(carol), (q) => q(
      "insert into notification_settings (workspace_id, user_id) values ($1, $2)", [wsA, alice]))).rejects.toThrow(/row-level security/);
    await db.as(user(carol), (q) => q("insert into notification_settings (workspace_id, user_id, approvals_email) values ($1, $2, false)", [wsA, carol]));
    expect(await db.as(user(carol), (q) => q("select approvals_email from notification_settings"))).toEqual([{ approvals_email: false }]);
    await expect(db.as(user(bob), (q) => q(
      "insert into notification_settings (workspace_id, user_id) values ($1, $2)", [wsA, bob]))).rejects.toThrow(/row-level security/);
  });

  it("users can't mark a request as already notified", async () => {
    await expect(db.as(user(alice), (q) => q(
      `insert into approval_requests (workspace_id, client_id, kind, requested_by, ad_account_id, target_type, target_id, notified_at)
       select $1, $2, 'campaign.pause', $3, a.id, 'campaign', 'cmp-n', now() from ad_accounts a where a.client_id = $2`,
      [wsA, clientA1, alice]))).rejects.toThrow(/row-level security/);
  });
});

