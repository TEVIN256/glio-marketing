import { describe, expect, it } from "vitest";
import { PlatformError, TikTokConnector, type FetchLike } from "../src/index.js";
import { PAGE_1 } from "./fixtures/tiktok-report.js";

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
    });
  });

  it("treats missing metrics as 'not provided', never as zero", async () => {
    const body = structuredClone(PAGE_1);
    const first = body.data.list[0]!;
    delete (first.metrics as Record<string, unknown>)["conversion"];
    (first.metrics as Record<string, unknown>)["clicks"] = "";
    const { fetch } = fakeFetch([{ status: 200, body }]);
    const page = await new TikTokConnector({ fetch }).fetchDailyReportPage(request);
    expect(page.rows[0]!.conversions).toBeNull();
    expect(page.rows[0]!.clicks).toBeNull();
  });

  it("marks rate limits and server errors as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const { fetch } = fakeFetch([{ status, body: {} }]);
      const err = await new TikTokConnector({ fetch }).fetchDailyReportPage(request).catch((e) => e);
      expect(err).toBeInstanceOf(PlatformError);
      expect(err.retryable).toBe(true);
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
