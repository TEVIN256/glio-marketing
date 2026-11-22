import { describe, expect, it } from "vitest";
import { type FetchLike, PlatformError, TikTokConnector } from "../src/index.ts";

const APP_ID = "test-app-id";
const SECRET = "test-app-secret-must-never-leak";
const TOKEN = "test-access-token-must-never-leak";

function fakeTikTok(responses: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url, init) => {
    calls.push(url);
    expect(JSON.stringify(init?.headers ?? {})).toContain(TOKEN); // token only in the header
    const path = new URL(url).pathname.replace("/open_api/v1.3", "");
    const body = responses[path];
    if (body === undefined) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => body };
  };
}

describe("TikTokConnector.listAdvertisers", () => {
  it("lists the authorised advertisers with name, currency and timezone (synthetic data)", async () => {
    const calls: string[] = [];
    const connector = new TikTokConnector({
      fetch: fakeTikTok({
        "/oauth2/advertiser/get/": { code: 0, message: "OK", data: { list: [
          { advertiser_id: "7000000000000000001", advertiser_name: "Test Client A1" },
          { advertiser_id: "7000000000000000002", advertiser_name: "Test Client A2" },
        ] } },
        "/advertiser/info/": { code: 0, message: "OK", data: { list: [
          { advertiser_id: "7000000000000000001", name: "Test Client A1 (KSA)", currency: "SAR", timezone: "Etc/GMT-3", display_timezone: "Asia/Riyadh" },
          { advertiser_id: "7000000000000000002", name: "", currency: "riyal", timezone: "UTC+3" },
        ] } },
      }, calls),
    });
    const list = await connector.listAdvertisers({ appId: APP_ID, appSecret: SECRET, accessToken: TOKEN });
    expect(list).toEqual([
      { externalId: "7000000000000000001", name: "Test Client A1 (KSA)", currency: "SAR", timezone: "Asia/Riyadh" },
      { externalId: "7000000000000000002", name: "Test Client A2", currency: null, timezone: null },
    ]);
    const info = new URL(calls[1]!);
    expect(JSON.parse(info.searchParams.get("advertiser_ids")!)).toEqual(["7000000000000000001", "7000000000000000002"]);
  });

  it("returns an empty list without calling advertiser/info when nothing is authorised", async () => {
    const calls: string[] = [];
    const connector = new TikTokConnector({
      fetch: fakeTikTok({ "/oauth2/advertiser/get/": { code: 0, message: "OK", data: { list: [] } } }, calls),
    });
    expect(await connector.listAdvertisers({ appId: APP_ID, appSecret: SECRET, accessToken: TOKEN })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("refuses an advertiser ID sent as a number too large to be exact", async () => {
    const connector = new TikTokConnector({
      fetch: fakeTikTok({ "/oauth2/advertiser/get/": { code: 0, message: "OK", data: { list: [{ advertiser_id: 2 ** 60 }] } } }),
    });
    const err = await connector.listAdvertisers({ appId: APP_ID, appSecret: SECRET, accessToken: TOKEN }).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.code).toBe("bad_shape");
  });

  it("never puts the app secret or token in error messages", async () => {
    const connector = new TikTokConnector({
      fetch: fakeTikTok({
        "/oauth2/advertiser/get/": { code: 40001, message: `invalid secret ${SECRET} for token ${TOKEN}` },
      }),
    });
    const err = await connector.listAdvertisers({ appId: APP_ID, appSecret: SECRET, accessToken: TOKEN }).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(TOKEN);
    expect(err.code).toBe("tiktok_40001");
  });
});
