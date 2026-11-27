import { describe, expect, it } from "vitest";
import { type FetchLike, PlatformError, ZidConnector, redactOrder, utcOffsetFor } from "../src/index.ts";
import { zidOrder } from "./fixtures/zid-orders.ts";

const tokens = { authorization: "test-authorization-jwt", managerToken: "test-manager-token", refreshToken: "test-refresh", expiresIn: null };

describe("Zid OAuth", () => {
  it("builds the authorize URL with state and exchanges the code with a form body", async () => {
    const url = new URL(ZidConnector.authorizationUrl({ clientId: "123", redirectUri: "https://app.example.test/integrations/zid/callback", state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://oauth.zid.sa/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "123", redirect_uri: "https://app.example.test/integrations/zid/callback", response_type: "code", state: "s1",
    });

    let seen: { url: string; body?: string; headers?: Record<string, string> } | null = null;
    const fetch: FetchLike = async (u, init) => {
      seen = { url: u, body: init?.body, headers: init?.headers };
      return { status: 200, json: async () => ({ token_type: "Bearer", expires_in: 94608000, authorization: "a", access_token: "m", refresh_token: "r" }) };
    };
    const t = await new ZidConnector({ fetch }).exchangeCode({ clientId: "123", clientSecret: "sec", redirectUri: "https://x.example.test/cb", code: "c1" });
    expect(t).toEqual({ authorization: "a", managerToken: "m", refreshToken: "r", expiresIn: 94608000 });
    expect(seen!.url).toBe("https://oauth.zid.sa/oauth/token");
    expect(seen!.url).not.toContain("sec"); // secret in the body, never the URL
    expect(Object.fromEntries(new URLSearchParams(seen!.body))).toEqual({
      grant_type: "authorization_code", client_id: "123", client_secret: "sec", redirect_uri: "https://x.example.test/cb", code: "c1",
    });
  });

  it("refuses a token response that lacks a token, and maps 401 to a reconnect error", async () => {
    const missing: FetchLike = async () => ({ status: 200, json: async () => ({ authorization: "a", access_token: "m" }) });
    await expect(new ZidConnector({ fetch: missing }).refresh({ clientId: "1", clientSecret: "s", redirectUri: "u", refreshToken: "r" }))
      .rejects.toMatchObject({ code: "ZID_TOKEN_FAILED" });
    const denied: FetchLike = async () => ({ status: 401, json: async () => ({}) });
    await expect(new ZidConnector({ fetch: denied }).getStore(tokens)).rejects.toMatchObject({ code: "ZID_UNAUTHORIZED", retryable: false });
    const busy: FetchLike = async () => ({ status: 429, json: async () => ({}) });
    const err = await new ZidConnector({ fetch: busy }).getStore(tokens).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
  });
});

describe("Zid store and orders", () => {
  it("sends both tokens and English on every call; reads store id, name, time zone and currency", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      if (url.endsWith("/localization")) return { status: 200, json: async () => ({ localization: { currency: { code: "SAR" } } }) };
      return { status: 200, json: async () => ({ store: { id: 42, title: "Test Store", timezone: "Asia/Riyadh", email: "store@example.test" } }) };
    };
    expect(await new ZidConnector({ fetch }).getStore(tokens)).toEqual({ externalId: "42", name: "Test Store", timezone: "Asia/Riyadh", currency: "SAR" });
    expect(calls[0]!.url).toBe("https://api.zid.sa/v1/managers/account/store");
    expect(calls[0]!.headers).toMatchObject({
      Authorization: "Bearer test-authorization-jwt", "X-Manager-Token": "test-manager-token", "Accept-Language": "en",
    });
  });

  it("asks for one store day with an explicit offset, follows pages, de-duplicates, and drops personal data", async () => {
    const urls: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => zidOrder(i + 1));
    const page2 = [zidOrder(100), zidOrder(101)]; // 100 again: the list shifted between pages
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("page");
      return { status: 200, json: async () => ({ status: "object", orders: page === "1" ? page1 : page2, total_order_count: 102 }) };
    };
    const day = await new ZidConnector({ fetch }).ordersForDay(tokens, "2026-01-01", "+0300");
    const q = Object.fromEntries(new URL(urls[0]!).searchParams);
    expect(q).toEqual({
      payload_type: "simple", per_page: "100", date_attribute: "created_at",
      date_from: "2026-01-01T00:00:00.000+0300", date_to: "2026-01-01T23:59:59.999+0300", page: "1",
    });
    expect(urls).toHaveLength(2);
    expect(day.orders).toHaveLength(101);
    const text = JSON.stringify(day);
    for (const personal of ["Test Customer", "customer@example.test", "966500000000", "Test Street", "Test City"]) expect(text).not.toContain(personal);
    expect(day.orders[0]).toEqual({
      id: "1", created_at: "2026-01-01 10:00:00", status: "new", payment_status: "paid", order_total: "100.00", currency_code: "SAR", source: "Store",
    });
  });

  it("redacts numeric totals and status codes as text, and computes UTC offsets", () => {
    expect(redactOrder(zidOrder(7, { order_total: 55.5, order_status: { name: "x", code: 3 } }))).toMatchObject({ order_total: "55.5", status: "3" });
    expect(utcOffsetFor("Asia/Riyadh", "2026-06-01")).toBe("+0300");
    expect(utcOffsetFor("UTC", "2026-06-01")).toBe("+0000");
  });
});
