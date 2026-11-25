import { describe, expect, it } from "vitest";
import { PlatformError, TikTokConnector, type FetchLike } from "../src/index.ts";
import { PAGE_1, tiktokAccountTotals } from "./fixtures/tiktok-report.ts";

const TOKEN = "test-secret-token-should-never-leak";

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return { status: next.status, json: async () => next.body };
  };
  return { fetch, calls };
}

const request = { accessToken: TOKEN, externalAccountId: "test-advertiser-1", dateFrom: "2026-01-01", dateTo: "2026-01-03", page: 1 };

describe("TikTokConnector.fetchDailyReportPage", () => {
  it("sends the token only in the header and maps rows without changing numbers", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: PAGE_1 }]);
    const page = await new TikTokConnector({ fetch }).fetchDailyReportPage(request);

    const call = calls[0]!;
    expect(call.init?.headers?.["Access-Token"]).toBe(TOKEN);
    expect(call.url).not.toContain(TOKEN);
    expect(JSON.stringify(page.requestParams)).not.toContain(TOKEN);
    expect(new URL(call.url).searchParams.get("advertiser_id")).toBe("test-advertiser-1");
    expect(JSON.parse(new URL(call.url).searchParams.get("dimensions")!)).toEqual(["campaign_id", "stat_time_day"]);
    // Deleted campaigns are included, so campaign rows add up to the account totals.
    expect(JSON.parse(new URL(call.url).searchParams.get("filtering")!)).toEqual([
      { field_name: "campaign_status", filter_type: "IN", filter_value: '["STATUS_ALL"]' },
    ]);

    expect(page.payload).toBe(PAGE_1); // stored exactly as received
    expect(page.hashBasis).not.toHaveProperty("request_id"); // fingerprint ignores the per-call id
    expect(page.hashBasis).toHaveProperty("data");
    expect(page.page).toBe(1);
    expect(page.totalPages).toBe(2);
    expect(page.rows[0]).toEqual({
      level: "campaign",
      entityId: "test-campaign-001",
      entityName: "Test Campaign One",
      date: "2026-01-01",
      spend: "120.50",
      impressions: 10000,
      clicks: 250,
      conversions: "12",
      purchaseValue: "1440.00",
    });
    // Purchase value and TikTok's own ROAS are requested (ROAS only so the raw payload keeps it for checks).
    const metrics = JSON.parse(new URL(call.url).searchParams.get("metrics")!);
    expect(metrics).toEqual(expect.arrayContaining(["total_complete_payment_rate", "complete_payment_roas"]));
  });

  it("treats missing metrics as 'not provided', never as zero", async () => {
    const body = structuredClone(PAGE_1);
    const first = body.data.list[0]!;
    delete (first.metrics as Record<string, unknown>)["conversion"];
    (first.metrics as Record<string, unknown>)["clicks"] = "-"; // TikTok's "no value"
    (first.metrics as Record<string, unknown>)["total_complete_payment_rate"] = "-"; // e.g. no website purchase tracking
    const { fetch } = fakeFetch([{ status: 200, body }]);
    const page = await new TikTokConnector({ fetch }).fetchDailyReportPage(request);
    expect(page.rows[0]!.conversions).toBeNull();
    expect(page.rows[0]!.clicks).toBeNull();
    expect(page.rows[0]!.purchaseValue).toBeNull();
  });

  it("marks rate limits and server errors as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const { fetch } = fakeFetch([{ status, body: {} }]);
      const err = await new TikTokConnector({ fetch }).fetchDailyReportPage(request).catch((e) => e);
      expect(err).toBeInstanceOf(PlatformError);
      expect(err.retryable).toBe(true);
    }
  });

  it("marks TikTok's throttling and system error codes as retryable, other codes not", async () => {
    for (const [code, retryable] of [[40100, true], [40133, true], [50000, true], [60001, true], [40105, false], [40002, false]] as const) {
      const { fetch } = fakeFetch([{ status: 200, body: { code, message: "x", data: {} } }]);
      const err = await new TikTokConnector({ fetch }).fetchDailyReportPage(request).catch((e) => e);
      expect([err.code, err.retryable]).toEqual([`tiktok_${code}`, retryable]);
    }
  });

  it("reports TikTok business errors without leaking the token", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { code: 40001, message: `bad token ${TOKEN}\nmore`, data: {} } }]);
    const err = await new TikTokConnector({ fetch }).fetchDailyReportPage(request).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.code).toBe("tiktok_40001");
    expect(err.retryable).toBe(false);
    // The platform echoed the token back: it must be redacted.
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain("\n");
  });

  it("rejects malformed rows instead of guessing", async () => {
    const body = structuredClone(PAGE_1);
    (body.data.list[0]!.metrics as Record<string, unknown>)["impressions"] = "12.5";
    const { fetch } = fakeFetch([{ status: 200, body }]);
    await expect(new TikTokConnector({ fetch }).fetchDailyReportPage(request)).rejects.toThrow(/non-integer/);
  });
});

describe("TikTok authorization", () => {
  it("builds the approval URL with app id, redirect and state", () => {
    const url = new URL(TikTokConnector.authorizationUrl({ appId: "test-app", redirectUri: "https://app.example.test/cb", state: "xyz" }));
    expect(url.searchParams.get("app_id")).toBe("test-app");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.test/cb");
    expect(url.searchParams.get("state")).toBe("xyz");
  });

  it("exchanges the auth code for a token", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { code: 0, message: "OK", data: { access_token: "new-token", advertiser_ids: ["test-advertiser-1"] } } },
    ]);
    const result = await new TikTokConnector({ fetch }).exchangeAuthCode({ appId: "a", appSecret: "s", authCode: "c" });
    expect(result).toEqual({ accessToken: "new-token", advertiserIds: ["test-advertiser-1"] });
    expect(calls[0]!.init?.method).toBe("POST");
  });
});

describe("TikTokConnector.fetchAccountTotals", () => {
  it("asks for account-level totals over the range and returns them as sent", async () => {
    const body = tiktokAccountTotals({ spend: "337.89", impressions: "30600", clicks: "635", conversion: "29" });
    const { fetch, calls } = fakeFetch([{ status: 200, body }]);
    const totals = await new TikTokConnector({ fetch }).fetchAccountTotals({
      accessToken: TOKEN, externalAccountId: "test-advertiser-1", dateFrom: "2026-01-01", dateTo: "2026-01-03",
    });
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.get("data_level")).toBe("AUCTION_ADVERTISER");
    expect(params.get("start_date")).toBe("2026-01-01");
    expect(params.get("end_date")).toBe("2026-01-03");
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(totals).toMatchObject({ spend: "337.89", impressions: 30600, clicks: 635, conversions: "29" });
    expect(totals.payload).toBe(body);
  });

  it("reports an empty answer as empty, not as zero", async () => {
    const body = tiktokAccountTotals({ spend: "1", impressions: "1", clicks: "1", conversion: "1" });
    body.data.list = [];
    const { fetch } = fakeFetch([{ status: 200, body }]);
    const totals = await new TikTokConnector({ fetch }).fetchAccountTotals({ accessToken: TOKEN, externalAccountId: "x", dateFrom: "2026-01-01", dateTo: "2026-01-01" });
    expect(totals).toMatchObject({ empty: true, spend: null, impressions: null, clicks: null, conversions: null });
  });

  it("refuses an ambiguous multi-row totals response", async () => {
    const body = tiktokAccountTotals({ spend: "1", impressions: "1", clicks: "1", conversion: "1" });
    body.data.list.push(body.data.list[0]!);
    const { fetch } = fakeFetch([{ status: 200, body }]);
    await expect(
      new TikTokConnector({ fetch }).fetchAccountTotals({ accessToken: TOKEN, externalAccountId: "x", dateFrom: "2026-01-01", dateTo: "2026-01-01" }),
    ).rejects.toThrow(/expected 1/);
  });
});
