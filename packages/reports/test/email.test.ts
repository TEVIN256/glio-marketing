import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, service, superuser, user } from "@glio/db/test-harness";
import { type FetchLike, TikTokConnector } from "@glio/connectors";
import { InMemorySecretStore, type SqlExecutor, reconcile, runSync } from "@glio/sync";
import { PAGE_1, PAGE_2, tiktokAccountTotals } from "../../connectors/test/fixtures/tiktok-report.ts";
import {
  type ChannelTotals, type MailFetch, type MailMessage, type Mailer, MailError, ResendMailer, buildReport, deliverReport,
  hashShareToken, isoWeekday, latestScheduledRun, openShare, createShare, normalizeRecipients, renderReportEmail, runScheduledReports, scheduledRunIfDue,
} from "../src/index.ts";

/**
 * M6: emailed reports. The email shows exactly the stored snapshot's figures,
 * each recipient gets their own email, every attempt is logged, and a
 * scheduled report is sent once per period even if the job runs again.
 */

const tiktok: ChannelTotals = {
  scope: "tiktok", currency: "SAR", rows: 6, spendMinor: 33789n, impressions: 30600n, clicks: 635n,
  conversionsScaled: 290000n, rawPayloadIds: [11, 12], reconciliation: "ok",
};
const report = buildReport({ period: { from: "2026-01-01", to: "2026-01-03" }, channels: [tiktok], total: null, digits: "latn" });
const commentary = { ar: "بلغ إنفاق تيك توك 337.89 ر.س.", en: "TikTok spend was SAR 337.89.", source: "llm" as const };

describe("renderReportEmail", () => {
  it("shows every figure exactly as stored, in Arabic, right-to-left", () => {
    const email = renderReportEmail({ report, commentary, clientName: "Test Client A1", lang: "ar", contactEmail: "info@example.test" });
    expect(email.html).toContain('dir="rtl"');
    for (const f of report.figures.filter((x) => x.status === "value")) expect(email.html).toContain(f.display!.ar);
    expect(email.html).toContain("غير متوفر من المنصة"); // ROAS has no revenue source
    expect(email.html).toContain("مطابق للمنصة");
    expect(email.text).toContain("337.89 ر.س");
    expect(email.subject).toBe("تقرير أداء Test Client A1: 2026-01-01 إلى 2026-01-03");
  });

  it("renders English when asked", () => {
    const email = renderReportEmail({ report, commentary, clientName: "Test Client A1", lang: "en", contactEmail: "info@example.test" });
    expect(email.html).toContain('dir="ltr"');
    expect(email.html).toContain("SAR 337.89");
    expect(email.html).toContain("TikTok spend was");
  });

  it("escapes names and keeps the subject on one line", () => {
    const email = renderReportEmail({
      report, commentary, clientName: 'Evil <script>alert(1)</script>\r\nBcc: x@example.test', lang: "en", contactEmail: "info@example.test",
      snapshotUrl: 'https://example.test/r/1"><script>',
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it("isolates numbers inside Arabic text", () => {
    const email = renderReportEmail({ report, commentary, clientName: "Test Client A1", lang: "ar", contactEmail: "info@example.test" });
    expect(email.html).toContain('<span dir="ltr" style="unicode-bidi:isolate">337.89</span>');
  });
});

describe("ResendMailer", () => {
  const KEY = "re_test_key_must_never_leak";
  it("posts one recipient per email with the idempotency key, and returns the message id", async () => {
    const calls: Array<{ url: string; init: Parameters<MailFetch>[1] }> = [];
    const mailer = new ResendMailer(KEY, async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ id: "msg_123" }) };
    });
    const res = await mailer.send({ from: "GLIO <reports@example.test>", to: "a@example.test", subject: "S", html: "<p>h</p>", text: "t", replyTo: "info@example.test", idempotencyKey: "k1" });
    expect(res).toEqual({ id: "msg_123" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "Idempotency-Key": "k1" });
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ to: ["a@example.test"], reply_to: "info@example.test", subject: "S" });
  });

  it("reports failures with a code, never with the key or the response body", async () => {
    const mailer = new ResendMailer(KEY, async () => ({ status: 422, json: async () => ({ message: `bad key ${KEY}` }) }));
    const err = await mailer.send({ from: "f@example.test", to: "a@example.test", subject: "S", html: "h", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe("RESEND_422");
    expect(err.message).not.toContain(KEY);
    expect(() => new ResendMailer("")).toThrow(MailError);
  });
});

describe("schedule math (Asia/Riyadh dates)", () => {
  it("knows ISO weekdays", () => {
    expect(isoWeekday("2026-01-04")).toBe(7); // Sunday
    expect(isoWeekday("2026-01-05")).toBe(1); // Monday
  });

  it("weekly: the 7 days before the latest send day", () => {
    expect(latestScheduledRun({ frequency: "weekly", sendWeekday: 7 }, "2026-01-04"))
      .toEqual({ sendDate: "2026-01-04", period: { from: "2025-12-28", to: "2026-01-03" } });
    expect(latestScheduledRun({ frequency: "weekly", sendWeekday: 7 }, "2026-01-06").sendDate).toBe("2026-01-04");
  });

  it("monthly: sent on the 1st for the previous month (leap years included)", () => {
    expect(latestScheduledRun({ frequency: "monthly", sendWeekday: 7 }, "2028-03-01"))
      .toEqual({ sendDate: "2028-03-01", period: { from: "2028-02-01", to: "2028-02-29" } });
    expect(latestScheduledRun({ frequency: "monthly", sendWeekday: 7 }, "2026-01-02").period)
      .toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("is due on the send day and for two catch-up days, then not", () => {
    const s = { frequency: "weekly" as const, sendWeekday: 7 };
    expect(scheduledRunIfDue(s, "2026-01-04")).not.toBeNull();
    expect(scheduledRunIfDue(s, "2026-01-06")).not.toBeNull();
    expect(scheduledRunIfDue(s, "2026-01-07")).toBeNull();
    expect(scheduledRunIfDue({ frequency: "off", sendWeekday: 7 }, "2026-01-04")).toBeNull();
  });

  it("normalises recipient lists (commas, Arabic commas, new lines, duplicates, case)", () => {
    expect(normalizeRecipients("A@Example.test, b@example.test،\nA@example.test  not-an-email")).toEqual({
      valid: ["a@example.test", "b@example.test"], invalid: ["not-an-email"],
    });
  });
});

// ---------------------------------------------------------------------------
// Delivery against the database (synthetic data).

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let wsId: string;
let clientId: string;

const tiktokFetch: FetchLike = async (url) => {
  const p = new URL(url).searchParams;
  const body = p.get("data_level") === "AUCTION_ADVERTISER"
    ? tiktokAccountTotals({ spend: "337.89", impressions: "30600", clicks: "635", conversion: "29" })
    : Number(p.get("page")) === 1 ? PAGE_1 : PAGE_2;
  return { status: 200, json: async () => ({ ...(structuredClone(body) as object), request_id: randomUUID() }) };
};

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  failFor = new Set<string>();
  async send(m: MailMessage) {
    if (this.failFor.has(m.to)) throw new MailError("Resend returned HTTP 500", "RESEND_500", true);
    this.sent.push(m);
    return { id: `msg_${this.sent.length}` };
  }
}

const deps = (mailer: Mailer) => ({
  db: exec, mailer, model: null, from: "GLIO Reports <reports@example.test>", replyTo: "info@example.test", appUrl: "https://app.example.test",
});
const deliveries = () => db.as(superuser, (q) => q(
  "select recipient, trigger, status, error_code, snapshot_id is not null as has_snapshot from report_deliveries order by id"));

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as(service, (q) => q(t, p)), transaction: (fn) => db.as(service, fn) };
  owner = await db.createUser("email-owner@example.test");
  wsId = (await db.as(user(owner), async (q) => (await q("select public.create_workspace('Test Agency Email', 'agency') as id"))[0]!)).id;
  let accountId = "";
  await db.as(user(owner), async (q) => {
    clientId = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client E1') returning id", [wsId]))[0]!.id;
    accountId = (await q(
      "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency) values ($1, $2, 'tiktok', 'test-advertiser-e1', 'SAR') returning id",
      [wsId, clientId]))[0]!.id;
    await q(
      "insert into report_schedules (workspace_id, client_id, frequency, send_weekday, language, recipients) values ($1, $2, 'weekly', 7, 'ar', $3)",
      [wsId, clientId, ["owner-e1@example.test", "client-e1@example.test"]]);
  });
  const secrets = new InMemorySecretStore();
  await secrets.put("secret://test/email", "test-token-email");
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'secret://test/email')", [accountId, wsId]);
  const syncDeps = { db: exec, connector: new TikTokConnector({ fetch: tiktokFetch }), secrets, retry: { sleep: async () => {} } };
  const sync = await runSync(syncDeps, { adAccountId: accountId, kind: "manual", dateFrom: "2026-01-01", dateTo: "2026-01-03" });
  expect(sync.status).toBe("succeeded");
  await reconcile({ ...syncDeps, log: () => {} }, { syncRunId: sync.syncRunId });
});

afterAll(async () => {
  await db?.destroy();
});

describe("scheduled report delivery (M6)", () => {
  it("not due: sends nothing", async () => {
    const mailer = new FakeMailer();
    expect(await runScheduledReports(deps(mailer), "2026-01-08")).toEqual([]);
    expect(mailer.sent).toEqual([]);
  });

  it("a failed data refresh sends nothing and is logged for retry", async () => {
    const mailer = new FakeMailer();
    const out = await runScheduledReports({
      ...deps(mailer), refresh: async () => { throw Object.assign(new Error("sync failed"), { code: "SYNC_FAILED" }); },
    }, "2026-01-04");
    expect(out).toMatchObject([{ status: "failed", errorCode: "REFRESH_SYNC_FAILED" }]);
    expect(mailer.sent).toEqual([]);
    expect(await deliveries()).toEqual([
      { recipient: "owner-e1@example.test", trigger: "schedule", status: "failed", error_code: "REFRESH_SYNC_FAILED", has_snapshot: false },
      { recipient: "client-e1@example.test", trigger: "schedule", status: "failed", error_code: "REFRESH_SYNC_FAILED", has_snapshot: false },
    ]);
  });

  it("due: one email per recipient, showing exactly the stored snapshot; one recipient fails", async () => {
    const mailer = new FakeMailer();
    mailer.failFor.add("client-e1@example.test");
    const refreshed: unknown[] = [];
    const out = await runScheduledReports({ ...deps(mailer), refresh: async (c) => { refreshed.push(c); } }, "2026-01-05");
    expect(refreshed).toEqual([{ workspaceId: wsId, clientId, period: { from: "2025-12-28", to: "2026-01-03" } }]);
    expect(out).toMatchObject([{ status: "partial", sent: 1, failed: 1, errorCode: "RESEND_500" }]);
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner-e1@example.test"]);

    const [snap] = await db.as(superuser, (q) => q(
      "select id, report, created_by_label from report_snapshots order by created_at desc limit 1"));
    expect(snap!.created_by_label).toBe("scheduler");
    for (const f of (snap!.report.figures as Array<{ status: string; display?: { ar: string } }>).filter((x) => x.status === "value")) {
      expect(mailer.sent[0]!.html).toContain(f.display!.ar);
    }
    // The button is a read-only share link (works without a GLIO account), stored only as a hash.
    const link = mailer.sent[0]!.html.match(/https:\/\/app\.example\.test\/s\/([A-Za-z0-9_-]{43})/);
    expect(link).not.toBeNull();
    const [share] = await db.as(superuser, (q) => q("select snapshot_id, token_hash, created_by_label from report_shares order by created_at desc limit 1"));
    expect(share).toMatchObject({ snapshot_id: snap!.id, token_hash: hashShareToken(link![1]!), created_by_label: "report-email" });
    expect(mailer.sent[0]!.idempotencyKey).toBe(`glio-report-${snap!.id}-owner-e1@example.test`);
    expect(mailer.sent[0]!.replyTo).toBe("info@example.test");
  });

  it("running again sends only to the recipient that failed, then nothing", async () => {
    const mailer = new FakeMailer();
    const first = await runScheduledReports(deps(mailer), "2026-01-06");
    expect(first).toMatchObject([{ status: "sent", sent: 1 }]);
    expect(mailer.sent.map((m) => m.to)).toEqual(["client-e1@example.test"]);
    const again = await runScheduledReports(deps(mailer), "2026-01-06");
    expect(again).toMatchObject([{ status: "already_sent" }]);
    expect(mailer.sent).toHaveLength(1);
    const sent = (await deliveries()).filter((d) => d.status === "sent").map((d) => d.recipient);
    expect(sent).toEqual(["owner-e1@example.test", "client-e1@example.test"]);
  });

  it("a manual send always sends (and records who sent it)", async () => {
    const mailer = new FakeMailer();
    const r = await deliverReport(deps(mailer), {
      clientId, period: { from: "2026-01-01", to: "2026-01-03" }, recipients: ["owner-e1@example.test"], language: "en",
      trigger: "manual", sentBy: owner,
    });
    expect(r.sent).toEqual(["owner-e1@example.test"]);
    expect(mailer.sent[0]!.html).toContain("SAR 337.89");
    const [row] = await db.as(superuser, (q) => q("select trigger, sent_by from report_deliveries order by id desc limit 1"));
    expect(row).toEqual({ trigger: "manual", sent_by: owner });
  });

  it("the client's team sees the delivery log; it holds no email content", async () => {
    const rows = await db.as(user(owner), (q) => q("select * from report_deliveries"));
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "client_id", "created_at", "error_code", "id", "period_from", "period_to", "provider", "provider_message_id",
      "recipient", "sent_by", "snapshot_id", "status", "trigger", "workspace_id",
    ]);
  });
});

describe("report share links", () => {
  it("open the report read-only and count views; revoked, expired or made-up links open nothing", async () => {
    const [snap] = await db.as(superuser, (q) => q("select id from report_snapshots order by created_at desc limit 1"));
    const { token, id } = await createShare(exec, { snapshotId: snap!.id, days: 7, createdBy: owner });
    const opened = await openShare(exec, token);
    expect(opened?.clientName).toBe("Test Client E1");
    expect(opened?.report.figures.length).toBeGreaterThan(0);
    await openShare(exec, token);
    const [row] = await db.as(superuser, (q) => q("select view_count, last_viewed_at is not null as seen from report_shares where id = $1", [id]));
    expect(row).toEqual({ view_count: 2, seen: true });

    expect(await openShare(exec, "x".repeat(43))).toBeNull();
    expect(await openShare(exec, "not-a-token")).toBeNull();
    await db.as(user(owner), (q) => q("update report_shares set revoked_at = now() where id = $1", [id]));
    expect(await openShare(exec, token)).toBeNull();

    const expired = await createShare(exec, { snapshotId: snap!.id, createdByLabel: "test" });
    await db.as(superuser, (q) => q("update report_shares set created_at = created_at - interval '2 days', expires_at = created_at - interval '1 day' where id = $1", [expired.id]));
    expect(await openShare(exec, expired.token)).toBeNull();
  });

  it("only owners and managers create links (as themselves), and can only revoke them", async () => {
    const [snap] = await db.as(superuser, (q) => q("select id, workspace_id, client_id from report_snapshots limit 1"));
    await expect(db.as(user(owner), (q) => q(
      "insert into report_shares (workspace_id, client_id, snapshot_id, token_hash, created_by, view_count) values ($1, $2, $3, repeat('f', 64), $4, 99)",
      [snap!.workspace_id, snap!.client_id, snap!.id, owner]))).rejects.toThrow(/row-level security/);
    await expect(db.as(user(owner), (q) => q("update report_shares set expires_at = now() + interval '300 days'"))).rejects.toThrow(/permission denied/);
  });
});

