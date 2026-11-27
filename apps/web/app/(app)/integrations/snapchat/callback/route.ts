import { type NextRequest, NextResponse } from "next/server";
import { SnapchatConnector } from "@glio/connectors";
import { VaultSecretStore, connectAdAccounts, createPendingConnection, newSecretRef } from "@glio/sync";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { SNAPCHAT_OAUTH_COOKIE, readPendingConnection } from "@/lib/oauth-state";
import { serverDb } from "@/lib/server-db";
import { finishAdConnection } from "@/lib/tiktok-connect";

// The first sync of the last 30 days runs before the redirect, so the client page opens with figures.
export const maxDuration = 60;

/**
 * Snapchat returns the user here (the OAuth app's redirect URI:
 * https://www.glioagency.org/integrations/snapchat/callback) with ?code&state.
 *
 * 1. The state must match the short-lived cookie set when "Connect Snapchat" was pressed.
 * 2. The signed-in user must still be an owner/manager of that client (checked under RLS).
 * 3. The code is exchanged server-side. GLIO keeps Snap's REFRESH token in Supabase Vault (access
 *    tokens last 1 hour and are minted per sync); the ad accounts the user can see are listed.
 * 4. One ad account: attached at once. Several: the owner chooses on /integrations/select/<id>.
 * 5. The last 30 complete days are synced right away.
 * The code and tokens are never logged, stored in tables, or shown.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const pending = readPendingConnection(request.cookies.get(SNAPCHAT_OAUTH_COOKIE)?.value, params.get("state"));
  const go = (path: string) => {
    const res = NextResponse.redirect(new URL(path, request.url));
    res.cookies.set(SNAPCHAT_OAUTH_COOKIE, "", { path: "/integrations/snapchat", maxAge: 0 });
    return res;
  };
  if (!pending) {
    console.error(JSON.stringify({
      event: "snapchat_state_failed", has_cookie: Boolean(request.cookies.get(SNAPCHAT_OAUTH_COOKIE)?.value),
      has_state: Boolean(params.get("state")), has_code: Boolean(params.get("code")), host: request.nextUrl.host,
    }));
    return go("/app?e=tiktok_state");
  }

  const base = `/w/${pending.ws}/c/${pending.client}`;
  const code = params.get("code");
  if (!code) return go(`${base}?e=snapchat&code=SNAPCHAT_CANCELLED`);

  const access = await clientAccess(pending.ws, pending.client);
  if (!access.canManage) return go(`${base}?e=forbidden`);
  if (!env.snapchatConfigured()) return go(`${base}?e=snapchat&code=SNAPCHAT_NOT_CONFIGURED`);

  try {
    const connector = new SnapchatConnector();
    const tokens = await connector.exchangeCode({
      clientId: env.snapchatClientId(), clientSecret: env.snapchatClientSecret(), redirectUri: env.snapchatRedirectUri(), code,
    });
    const accounts = await connector.listAdAccounts(tokens.accessToken);
    if (accounts.length === 0) return go(`${base}?e=snapchat&code=SNAPCHAT_NO_ACCOUNTS`);

    const db = serverDb();
    const secrets = new VaultSecretStore(db);
    // The stored token is the REFRESH token (`accessToken` is the field name the shared flow uses).
    if (accounts.length > 1) {
      const id = await createPendingConnection(
        { db, secrets },
        { workspaceId: pending.ws, clientId: pending.client, userId: access.user.id, platform: "snapchat", accessToken: tokens.refreshToken, accounts },
      );
      return go(`/integrations/select/${id}`);
    }
    const result = await connectAdAccounts(
      { db, secrets },
      {
        workspaceId: pending.ws, clientId: pending.client, userId: access.user.id, platform: "snapchat",
        accessToken: tokens.refreshToken, secretRef: newSecretRef("snapchat"), accounts,
      },
    );
    return go(`${base}?${await finishAdConnection(db, pending.ws, pending.client, result, "snapchat")}`);
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "snapchat_connect_failed", client: pending.client, code: d.code, error: d.message }));
    return go(`${base}?e=snapchat&code=${encodeURIComponent(d.code)}`);
  }
}
