import { describe, expect, it } from "vitest";
import { OAUTH_MAX_AGE_SECONDS, newPendingConnection, readPendingConnection } from "@/lib/oauth-state";

const WS = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";

describe("OAuth state for connecting TikTok", () => {
  it("round-trips when the returned state matches and the cookie is fresh", () => {
    const now = 1_800_000_000_000;
    const { state, cookie } = newPendingConnection(WS, CLIENT, now);
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(readPendingConnection(cookie, state, now + 1000)).toEqual({ state, ws: WS, client: CLIENT, iat: now });
  });

  it("rejects a different state, a missing cookie, an expired cookie and tampered content", () => {
    const now = 1_800_000_000_000;
    const { state, cookie } = newPendingConnection(WS, CLIENT, now);
    expect(readPendingConnection(cookie, state + "x", now)).toBeNull();
    expect(readPendingConnection(cookie, newPendingConnection(WS, CLIENT, now).state, now)).toBeNull();
    expect(readPendingConnection(undefined, state, now)).toBeNull();
    expect(readPendingConnection(cookie, null, now)).toBeNull();
    expect(readPendingConnection(cookie, state, now + OAUTH_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();
    const tampered = Buffer.from(JSON.stringify({ state, ws: "not-a-uuid", client: CLIENT, iat: now })).toString("base64url");
    expect(readPendingConnection(tampered, state, now)).toBeNull();
    expect(readPendingConnection("not base64 json", state, now)).toBeNull();
  });

  it("refuses to start for ids that aren't UUIDs", () => {
    expect(() => newPendingConnection("x", CLIENT)).toThrow();
  });
});
