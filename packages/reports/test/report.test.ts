import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, service, superuser, user } from "@glio/db/test-harness";
import { type FetchLike, TikTokConnector } from "@glio/connectors";
import { InMemorySecretStore, type SqlExecutor, reconcile, runSync } from "@glio/sync";
import { PAGE_1, PAGE_2, tiktokAccountTotals } from "../../connectors/test/fixtures/tiktok-report.ts";
import { type CommentaryModel, type Figure, type ReportModel, allowedNumbers, createReportSnapshot, extractNumbers } from "../src/index.ts";

/**
 * M5 GATE: every number stated in a generated (Arabic and English) report is
 * verifiable against the stored report_snapshot, and every figure traces to
 * the raw platform payloads it came from.
 */

let db: TestDb;
let exec: SqlExecutor;
let owner: string;
let wsId: string;
let clientId: string;
let accountId: string;
const secrets = new InMemorySecretStore();
const PERIOD = { dateFrom: "2026-01-01", dateTo: "2026-01-03" };

const fetch: FetchLike = async (url) => {
  const p = new URL(url).searchParams;
  const body = p.get("data_level") === "AUCTION_ADVERTISER"
    ? tiktokAccountTotals({ spend: "337.89", impressions: "30600", clicks: "635", conversion: "29" })
    : Number(p.get("page")) === 1 ? PAGE_1 : PAGE_2;
  return { status: 200, json: async () => ({ ...(structuredClone(body) as object), request_id: randomUUID() }) };
};

/** A model that writes from the figures it is given, like a well-behaved LLM. */
const honestModel: CommentaryModel = {
  name: "test-honest",
  async generate({ user: input }) {
    const figs = JSON.parse(input).figures as Array<{ id: string; display_en?: string; display_ar?: string }>;
    const d = (id: string) => figs.find((f) => f.id === id)!;
    return {
      ar: `خلال الفترة بلغ إنفاق تيك توك ${d("tiktok.spend").display_ar} مع ${d("tiktok.impressions").display_ar} ظهور و${d("tiktok.clicks").display_ar} نقرة، وبلغت نسبة النقر ${d("tiktok.ctr").display_ar}.`,
      en: `TikTok spend was ${d("tiktok.spend").display_en} with ${d("tiktok.impressions").display_en} impressions and ${d("tiktok.clicks").display_en} clicks; CTR was ${d("tiktok.ctr").display_en}.`,
    };
  },
};
/** A model that invents numbers every time. */
const inventingModel: CommentaryModel = {
  name: "test-inventing",
  async generate() {
    return { ar: "ارتفع الإنفاق بنسبة 18٪ مقارنة بالأسبوع الماضي.", en: "Spend rose 18% versus last week, to roughly SAR 340." };
  },
};

beforeAll(async () => {
  db = await TestDb.create();
  exec = { query: (t, p) => db.as(service, (q) => q(t, p)), transaction: (fn) => db.as(service, fn) };
  owner = await db.createUser("report-owner@example.test");
  wsId = (await db.as(user(owner), async (q) => (await q("select public.create_workspace('Test Agency Reports', 'agency') as id"))[0]!)).id;
  await db.as(user(owner), async (q) => {
    clientId = (await q("insert into clients (workspace_id, name) values ($1, 'Test Client P1') returning id", [wsId]))[0]!.id;
    accountId = (await q(
      "insert into ad_accounts (workspace_id, client_id, platform, external_id, currency) values ($1, $2, 'tiktok', 'test-advertiser-1', 'SAR') returning id",
      [wsId, clientId],
    ))[0]!.id;
  });
  await secrets.put("secret://test/report", "test-token-report");
  await exec.query("insert into ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'secret://test/report')", [accountId, wsId]);
  const deps = { db: exec, connector: new TikTokConnector({ fetch }), secrets, retry: { sleep: async () => {} } };
  const sync = await runSync(deps, { adAccountId: accountId, kind: "manual", ...PERIOD });
  expect(sync.status).toBe("succeeded");
  expect((await reconcile({ ...deps, log: () => {} }, { syncRunId: sync.syncRunId })).status).toBe("ok");
});

afterAll(async () => {
  await db?.destroy();
});

/**
 * Independent verifier: reads ONLY what was stored, and checks
 *  (1) every number in the stored Arabic and English commentary appears in
 *      the stored snapshot's figure displays (or the period dates);
 *  (2) every base figure equals the sum of the matching rows inside the raw
 *      payloads it cites, parsed straight from the stored JSON;
 *  (3) derived figures are consistent with the stored base figures.
 */
async function verifySnapshot(snapshotId: string) {
  const [s] = await exec.query(
    `select s.report, s.report_sha256, c.text_ar, c.text_en
     from report_snapshots s join ai_commentary c on c.id = s.commentary_id where s.id = $1`,
    [snapshotId],
  );
  const report = s!.report as ReportModel;
  const allowed = allowedNumbers(report.figures.flatMap((f) => (f.display ? [f.display.en, f.display.ar] : [])), report.period);
  const unverifiable = [...extractNumbers(s!.text_ar), ...extractNumbers(s!.text_en)].filter((n) => !allowed.has(n));
  expect(unverifiable, "numbers in the commentary not found in the snapshot").toEqual([]);

  const byId = new Map(report.figures.map((f) => [f.id, f] as [string, Figure]));
  for (const f of report.figures.filter((x) => x.status === "value" && ["spend", "impressions", "clicks", "conversions"].includes(x.metric))) {
    const raws = await exec.query("select payload from raw_platform_payloads where id = any($1::bigint[])", [f.rawPayloadIds]);
    expect(raws.length, `${f.id}: cited raw payloads missing`).toBe(f.rawPayloadIds.length);
    let total = 0n;
    for (const r of raws) {
      for (const item of r.payload.data.list) {
        const day = String(item.dimensions.stat_time_day).slice(0, 10);
        if (day < report.period.from || day > report.period.to) continue;
        const m = item.metrics;
        if (f.metric === "spend") total += BigInt(String(m.spend).replace(".", ""));
        if (f.metric === "impressions") total += BigInt(m.impressions);
        if (f.metric === "clicks") total += BigInt(m.clicks);
        if (f.metric === "conversions") total += BigInt(m.conversion);
      }
    }
    const v = f.value!;
    const stored = v.kind === "money" ? v.minor : v.kind === "count" || v.kind === "decimal" ? v.value : "";
    expect({ id: f.id, value: stored }).toEqual({ id: f.id, value: total.toString() });
  }
  const ctr = byId.get("tiktok.ctr")!;
  if (ctr.status === "value" && ctr.value!.kind === "ratio") {
    expect(ctr.value!.numerator).toBe((byId.get("tiktok.clicks")!.value as { value: string }).value);
    expect(ctr.value!.denominator).toBe((byId.get("tiktok.impressions")!.value as { value: string }).value);
  }
  return report;
}

describe("M5 gate", () => {
  it("an AI-written Arabic + English report: every stated number is verifiable against the snapshot and the raw payloads", async () => {
    const r = await createReportSnapshot({ db: exec, model: honestModel }, { clientId, ...PERIOD, createdBy: owner });
    expect(r.commentary.source).toBe("llm");
    const report = await verifySnapshot(r.snapshotId);
    expect(report.figures.find((f) => f.id === "tiktok.spend")!.display).toEqual({ en: "SAR 337.89", ar: "337.89 ر.س" });
    expect(report.channels).toEqual([{ scope: "tiktok", currency: "SAR", reconciliation: "ok" }]);
  });

  it("a model that invents numbers never reaches the client: rejected twice, template used, attempts logged", async () => {
    const r = await createReportSnapshot({ db: exec, model: inventingModel }, { clientId, ...PERIOD, createdBy: owner });
    expect(r.commentary.source).toBe("template");
    await verifySnapshot(r.snapshotId);
    const [c] = await exec.query("select source, model, attempts from ai_commentary where id = $1", [r.commentaryId]);
    expect(c!.source).toBe("template");
    expect(c!.model).toBe("test-inventing");
    expect(c!.attempts.map((a: any) => [a.kind, a.ok])).toEqual([["llm", false], ["llm_strict", false], ["template", true]]);
    expect(c!.attempts[0].violations).toContain("en: number not in input: 18");
  });

  it("Arabic-Indic digits work end to end", async () => {
    const r = await createReportSnapshot({ db: exec, model: honestModel }, { clientId, ...PERIOD, createdBy: owner, digits: "arab" });
    expect(r.commentary.ar).toContain("٣٣٧٫٨٩ ر.س");
    await verifySnapshot(r.snapshotId);
  });

  it("stores the exact model input with its hash, the prompt version and the report hash", async () => {
    const r = await createReportSnapshot({ db: exec, model: honestModel }, { clientId, ...PERIOD, createdByLabel: "scheduler" });
    const [row] = await exec.query(
      `select c.input, c.input_sha256, c.prompt_version, c.system_prompt_sha256, s.report_sha256, s.created_by_label
       from report_snapshots s join ai_commentary c on c.id = s.commentary_id where s.id = $1`,
      [r.snapshotId],
    );
    expect(row).toMatchObject({ input_sha256: r.commentary.inputSha256, prompt_version: "commentary-v1", report_sha256: r.reportSha256, created_by_label: "scheduler" });
    expect(row!.input).toEqual(r.commentary.input);
    expect(row!.system_prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a reviewer can go from any figure to the raw payload it came from (as a signed-in user)", async () => {
    const [snap] = await db.as(user(owner), (q) => q("select report from report_snapshots order by created_at limit 1"));
    const spend = (snap!.report as ReportModel).figures.find((f) => f.id === "tiktok.spend")!;
    const raws = await db.as(user(owner), (q) => q("select id, endpoint from raw_platform_payloads where id = any($1::bigint[])", [spend.rawPayloadIds]));
    expect(raws.length).toBe(spend.rawPayloadIds.length);
  });
});

describe("snapshots are permanent", () => {
  it("cannot be edited or deleted, by anyone", async () => {
    for (const t of ["report_snapshots", "ai_commentary"]) {
      await expect(exec.query(`update ${t} set created_at = now()`)).rejects.toThrow(/permission denied|cannot be changed/);
      await expect(exec.query(`delete from ${t}`)).rejects.toThrow(/cannot be changed/);
      await expect(db.as(superuser, (q) => q(`update ${t} set created_at = now()`))).rejects.toThrow(/cannot be changed/);
    }
  });

  it("signed-in users can read them but never write them", async () => {
    await expect(db.as(user(owner), (q) => q("delete from report_snapshots"))).rejects.toThrow(/permission denied/);
  });
});
