import { describe, expect, it } from "vitest";
import { type FetchLike, SnapchatConnector, dayStart, localDate, microToDecimal } from "../src/index.ts";

/** SYNTHETIC Snapchat responses, shaped after developers.snap.com (measurement.md, organizations.md, ad-accounts.md). */
const ACCOUNT = "test-snap-account-1";
const account = { request_status: "success", request_id: "r0", adaccounts: [{ sub_request_status: "success", adaccount: { id: ACCOUNT, name: "Test Snap Account", currency: "SAR", timezone: "Asia/Riyadh" } }] };
const campaigns = { request_status: "SUCCESS", request_id: "r1", campaigns: [
  { sub_request_status: "SUCCESS", campaign: { id: "test-camp-a", name: "Test Campaign A" } },
  { sub_request_status: "SUCCESS", campaign: { id: "test-camp-b", name: "Test Campaign B" } },
] };
const day = (start: string, stats: Record<string, number>) => ({ start_time: start, end_time: start, stats });
const statsPage = (campaignsBreakdown: unknown[], next?: string) => ({
  request_status: "SUCCESS", request_id: `r-${Math.random()}`,
  timeseries_stats: [{ sub_request_status: "SUCCESS", timeseries_stat: { id: ACCOUNT, type: "AD_ACCOUNT", granularity: "DAY", breakdown_stats: { campaign: campaignsBreakdown } } }],
  ...(next ? { paging: { next_link: next } } : {}),
});

function fakeSnap(pages: Record<string, unknown>) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const u = new URL(url);
    if (u.pathname.endsWith("/campaigns")) return { status: 200, json: async () => campaigns };
    if (u.pathname.endsWith("/stats")) {
      const body = pages[u.searchParams.get("cursor") ?? (u.searchParams.get("granularity") === "TOTAL" ? "total" : "first")];
      return { status: 200, json: async () => body };
    }
    return { status: 200, json: async () => account };
  };
  return { fetch, calls };
}

describe("Snapchat OAuth", () => {
  it("asks for the marketing API scope with state, and exchanges the code with a form body", async () => {
    const url = new URL(SnapchatConnector.authorizationUrl({ clientId: "cid", redirectUri: "https://app.example.test/integrations/snapchat/callback", state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.snapchat.com/login/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "https://app.example.test/integrations/snapchat/callback", response_type: "code", scope: "snapchat-marketing-api", state: "s1",
    });
    let body = "";
    const fetch: FetchLike = async (u, init) => {
      expect(u).toBe("https://accounts.snapchat.com/login/oauth2/access_token");
      body = init?.body ?? "";
      return { status: 200, json: async () => ({ access_token: "a1", refresh_token: "r1", expires_in: 3600, token_type: "Bearer" }) };
    };
    expect(await new SnapchatConnector({ fetch }).exchangeCode({ clientId: "cid", clientSecret: "sec", redirectUri: "https://x.example.test/cb", code: "c1" }))
      .toEqual({ accessToken: "a1", refreshToken: "r1", expiresIn: 3600 });
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: "authorization_code", client_id: "cid", client_secret: "sec", code: "c1", redirect_uri: "https://x.example.test/cb",
    });
  });

  it("keeps the old refresh token when a refresh doesn't return a new one", async () => {
    const fetch: FetchLike = async () => ({ status: 200, json: async () => ({ access_token: "a2", expires_in: 3600 }) });
    expect(await new SnapchatConnector({ fetch }).refresh({ clientId: "c", clientSecret: "s", refreshToken: "old" }))
      .toMatchObject({ accessToken: "a2", refreshToken: "old" });
  });
});

describe("Snapchat ad accounts and stats", () => {
  it("lists ad accounts across organizations", async () => {
    const fetch: FetchLike = async () => ({ status: 200, json: async () => ({ request_status: "SUCCESS", organizations: [
      { organization: { id: "o1", ad_accounts: [{ id: "x1", name: "Test A", currency: "SAR", timezone: "Asia/Riyadh" }, { id: "x2", name: "Test B", currency: "usd" }] } },
      { organization: { id: "o2", ad_accounts: [{ id: "x1", name: "Test A again" }] } },
    ] }) });
    expect(await new SnapchatConnector({ fetch }).listAdAccounts("tok")).toEqual([
      { externalId: "x1", name: "Test A", currency: "SAR", timezone: "Asia/Riyadh" },
      { externalId: "x2", name: "Test B", currency: null, timezone: null },
    ]);
  });

  it("requests campaign x day in the account's time zone, follows the next-page link, and converts micro-currency", async () => {
    const next = "https://adsapi.snapchat.com/v1/adaccounts/test-snap-account-1/stats?cursor=p2";
    const { fetch, calls } = fakeSnap({
      first: statsPage([{ id: "test-camp-a", timeseries: [
        day("2026-11-01T00:00:00.000+03:00", { impressions: 1000, swipes: 25, spend: 120_504_999, conversion_purchases: 3, conversion_purchases_value: 450_000_000 }),
        day("2026-10-31T21:00:00.000Z", { impressions: 10, swipes: 0, spend: 1_005_000 }), // = 2026-11-01 Riyadh: same day, other notation
      ] }], next),
      p2: statsPage([{ id: "test-camp-b", timeseries: [day("2026-11-02T00:00:00.000+03:00", { impressions: 5, swipes: 1, spend: 2_000_000, conversion_purchases: 0, conversion_purchases_value: 0 })] }]),
    });
    const c = new SnapchatConnector({ fetch });
    const p1 = await c.fetchDailyReportPage({ accessToken: "tok", externalAccountId: ACCOUNT, dateFrom: "2026-11-01", dateTo: "2026-11-02", page: 1 });
    const statsUrl = new URL(calls.find((x) => x.url.includes("/stats"))!.url);
    expect(Object.fromEntries(statsUrl.searchParams)).toMatchObject({
      granularity: "DAY", breakdown: "campaign", start_time: "2026-11-01T00:00:00.000+03:00", end_time: "2026-11-03T00:00:00.000+03:00",
      fields: "impressions,swipes,spend,conversion_purchases,conversion_purchases_value",
    });
    expect(calls.every((x) => x.headers?.Authorization === "Bearer tok")).toBe(true);
    expect(p1.totalPages).toBe(2);
    expect(p1.rows).toEqual([
      { level: "campaign", entityId: "test-camp-a", entityName: "Test Campaign A", date: "2026-11-01", spend: "120.50", impressions: 1000, clicks: 25, conversions: "3", purchaseValue: "450.00" },
      { level: "campaign", entityId: "test-camp-a", entityName: "Test Campaign A", date: "2026-11-01", spend: "1.01", impressions: 10, clicks: 0, conversions: null, purchaseValue: null },
    ]);
    const p2 = await c.fetchDailyReportPage({ accessToken: "tok", externalAccountId: ACCOUNT, dateFrom: "2026-11-01", dateTo: "2026-11-02", page: 2 });
    expect(p2.totalPages).toBe(2);
    expect(p2.rows[0]).toMatchObject({ entityId: "test-camp-b", date: "2026-11-02", spend: "2.00", conversions: "0", purchaseValue: "0.00" });
    expect(JSON.stringify(p1.requestParams)).not.toContain("tok");
  });

  it("refuses a next-page link to another host (the token would go with it)", async () => {
    const { fetch } = fakeSnap({ first: statsPage([], "https://evil.example.test/steal?cursor=x") });
    await expect(new SnapchatConnector({ fetch }).fetchDailyReportPage({ accessToken: "tok", externalAccountId: ACCOUNT, dateFrom: "2026-11-01", dateTo: "2026-11-01", page: 1 }))
      .rejects.toMatchObject({ code: "SNAPCHAT_BAD_RESPONSE" });
  });

  it("reads the account's own total spend for reconciliation; other metrics are not provided", async () => {
    const { fetch } = fakeSnap({ total: { request_status: "SUCCESS", total_stats: [{ total_stat: { id: ACCOUNT, type: "AD_ACCOUNT", granularity: "TOTAL", stats: { spend: 89_196_290 } } }] } });
    expect(await new SnapchatConnector({ fetch }).fetchAccountTotals({ accessToken: "tok", externalAccountId: ACCOUNT, dateFrom: "2026-11-01", dateTo: "2026-11-30" }))
      .toMatchObject({ empty: false, spend: "89.20", impressions: null, clicks: null, conversions: null, purchaseValue: null });
  });

  it("maps errors: 401 reconnect, 429 retryable, E9001 too large, and a 200 with an error status", async () => {
    const respond = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });
    const get = (f: FetchLike) => new SnapchatConnector({ fetch: f }).listAdAccounts("tok").catch((e) => e);
    expect(await get(respond(401, {}))).toMatchObject({ code: "SNAPCHAT_UNAUTHORIZED", retryable: false });
    expect(await get(respond(429, {}))).toMatchObject({ code: "SNAPCHAT_RATE_LIMITED", retryable: true });
    expect(await get(respond(400, { request_status: "ERROR", error_code: "E9001" }))).toMatchObject({ code: "SNAPCHAT_TOO_LARGE" });
    expect(await get(respond(200, { request_status: "ERROR", error_code: "E1001", display_message: "nope" }))).toMatchObject({ code: "E1001" });
  });
});

describe("helpers", () => {
  it("micro-currency to minor units, half-up; exact micro stays in the raw payload", () => {
    expect(microToDecimal(1_000_000, "SAR")).toBe("1.00");
    expect(microToDecimal(144_213_617, "SAR")).toBe("144.21");
    expect(microToDecimal(5_000, "SAR")).toBe("0.01"); // half a halala rounds up
    expect(microToDecimal(4_999, "SAR")).toBe("0.00");
    expect(microToDecimal("123450000", "KWD")).toBe("123.450");
    expect(microToDecimal(null, "SAR")).toBeNull();
    expect(() => microToDecimal(1.5, "SAR")).toThrow();
  });
  it("day boundaries and local dates", () => {
    expect(dayStart("2026-11-01", "Asia/Riyadh")).toBe("2026-11-01T00:00:00.000+03:00");
    expect(localDate("2026-10-31T21:00:00.000Z", "Asia/Riyadh")).toBe("2026-11-01");
    expect(localDate("2016-08-05T22:00:00.000-07:00", "America/Los_Angeles")).toBe("2016-08-05");
  });
});
