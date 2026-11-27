import { type NextRequest, NextResponse } from "next/server";
import { TikTokConnector } from "@glio/connectors";
import { VaultSecretStore, connectAdAccounts, createPendingConnection, newSecretRef } from "@glio/sync";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { TIKTOK_OAUTH_COOKIE, readPendingConnection } from "@/lib/oauth-state";
import { serverDb } from "@/lib/server-db";
import { finishAdConnection } from "@/lib/tiktok-connect";

// The first sync of the last 30 days runs before the redirect, so the client page opens with figures.
export const maxDuration = 60;

/**
 * TikTok for Business returns the advertiser here (registered redirect URL:
 * https://www.glioagency.org/integrations/tiktok/callback) with ?auth_code&state.
 *
 * 1. The state must match the short-lived cookie set when "Connect TikTok" was pressed.
 * 2. The signed-in user must still be an owner/manager of that client (checked under RLS).
 * 3. The auth code is exchanged server-side; the token goes to Supabase Vault,
 *    the authorised ad accounts are attached to the client, and each is audited.
 * 4. One ad account: attached at once. Several: the owner chooses which ones belong
 *    to this client on /integrations/select/<id> (migration 0015, ADR-032).
 * 5. The last 30 complete days are synced right away (the page's default period).
 *    If that fails the accounts stay connected and the page says so.
 * The auth code and token are never logged, stored in tables, or shown.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const pending = readPendingConnection(request.cookies.get(TIKTOK_OAUTH_COOKIE)?.value, params.get("state"));
  const go = (path: string) => {
    const res = NextResponse.redirect(new URL(path, request.url));
    res.cookies.set(TIKTOK_OAUTH_COOKIE, "", { path: "/integrations/tiktok", maxAge: 0 });
    return res;
  };
  if (!pending) {
    // Why, without logging the values: no cookie (expired, other browser or domain), no state, or a mismatch.
    console.error(JSON.stringify({
      event: "tiktok_state_failed", has_cookie: Boolean(request.cookies.get(TIKTOK_OAUTH_COOKIE)?.value),
      has_state: Boolean(params.get("state")), has_code: Boolean(params.get("auth_code") ?? params.get("code")), host: request.nextUrl.host,
    }));
    return go("/app?e=tiktok_state");
  }

  const base = `/w/${pending.ws}/c/${pending.client}`;
  const authCode = params.get("auth_code") ?? params.get("code"); // TikTok sends both; auth_code is the documented one
  if (!authCode) return go(`${base}?e=tiktok&code=TIKTOK_CANCELLED`);

  const access = await clientAccess(pending.ws, pending.client);
  if (!access.canManage) return go(`${base}?e=forbidden`);
  if (!env.tiktokConfigured()) return go(`${base}?e=tiktok&code=TIKTOK_NOT_CONFIGURED`);

  try {
    const appId = env.tiktokAppId();
    const appSecret = env.tiktokAppSecret();
    const connector = new TikTokConnector();
    const { accessToken } = await connector.exchangeAuthCode({ appId, appSecret, authCode });
    const accounts = await connector.listAdvertisers({ appId, appSecret, accessToken });
    if (accounts.length === 0) return go(`${base}?e=tiktok&code=TIKTOK_NO_ACCOUNTS`);

    const db = serverDb();
    const secrets = new VaultSecretStore(db);
    // More than one ad account: the owner chooses which belong to this client (nothing attached until then).
    if (accounts.length > 1) {
      const id = await createPendingConnection(
        { db, secrets },
        { workspaceId: pending.ws, clientId: pending.client, userId: access.user.id, platform: "tiktok", accessToken, accounts },
      );
      return go(`/integrations/select/${id}`);
    }
    const result = await connectAdAccounts(
      { db, secrets },
      {
        workspaceId: pending.ws, clientId: pending.client, userId: access.user.id, platform: "tiktok",
        accessToken, secretRef: newSecretRef("tiktok"), accounts,
      },
    );
    return go(`${base}?${await finishAdConnection(db, pending.ws, pending.client, result, "tiktok")}`);
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "tiktok_connect_failed", client: pending.client, code: d.code, error: d.message }));
    return go(`${base}?e=tiktok&code=${encodeURIComponent(d.code)}`);
  }
}
