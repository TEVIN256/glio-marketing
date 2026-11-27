import { type NextRequest, NextResponse } from "next/server";
import { ZidConnector } from "@glio/connectors";
import { todayIn } from "@glio/core";
import { VaultSecretStore, connectStore, newSecretRef } from "@glio/sync";
import { clientAccess } from "@/lib/authz";
import { presetPeriod } from "@/lib/delta";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { ZID_OAUTH_COOKIE, readPendingConnection } from "@/lib/oauth-state";
import { serverDb } from "@/lib/server-db";
import { syncClientStore } from "@/lib/store";

// The first sync of the last 30 days runs before the redirect (one request per store day).
export const maxDuration = 60;

/**
 * Zid returns the merchant here (the app's Callback URL:
 * https://www.glioagency.org/integrations/zid/callback) with ?code&state.
 *
 * 1. The state must match the short-lived cookie set when "Connect Zid store" was pressed.
 * 2. The signed-in user must still be an owner/manager of that client (checked under RLS).
 * 3. The code (valid 10 minutes, single use) is exchanged at once, server-side; the token set
 *    goes to Supabase Vault, the store is attached to the client and audited.
 * 4. The last 30 complete days are synced right away. If that fails the store stays connected.
 * The code and tokens are never logged, stored in tables, or shown.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const pending = readPendingConnection(request.cookies.get(ZID_OAUTH_COOKIE)?.value, params.get("state"));
  const go = (path: string) => {
    const res = NextResponse.redirect(new URL(path, request.url));
    res.cookies.set(ZID_OAUTH_COOKIE, "", { path: "/integrations/zid", maxAge: 0 });
    return res;
  };
  if (!pending) {
    console.error(JSON.stringify({
      event: "zid_state_failed", has_cookie: Boolean(request.cookies.get(ZID_OAUTH_COOKIE)?.value),
      has_state: Boolean(params.get("state")), has_code: Boolean(params.get("code")), host: request.nextUrl.host,
    }));
    // Arrived without pressing "Connect Zid store" in GLIO (e.g. straight from Zid): explain how to finish.
    return go("/integrations/zid/start");
  }

  const base = `/w/${pending.ws}/c/${pending.client}`;
  const code = params.get("code");
  if (!code) return go(`${base}?e=store&code=ZID_CANCELLED#store`);

  const access = await clientAccess(pending.ws, pending.client);
  if (!access.canManage) return go(`${base}?e=forbidden#store`);
  if (!env.zidConfigured()) return go(`${base}?e=store&code=ZID_NOT_CONFIGURED#store`);

  let connected = false;
  try {
    const connector = new ZidConnector();
    const tokens = await connector.exchangeCode({
      clientId: env.zidClientId(), clientSecret: env.zidClientSecret(), redirectUri: env.zidRedirectUri(), code,
    });
    const store = await connector.getStore(tokens);
    const db = serverDb();
    await connectStore(
      { db, secrets: new VaultSecretStore(db) },
      { workspaceId: pending.ws, clientId: pending.client, userId: access.user.id, platform: "zid", store, tokens, secretRef: newSecretRef("zid") },
    );
    connected = true;
    console.info(JSON.stringify({ event: "zid_connected", client: pending.client }));
    const period = presetPeriod("30d", todayIn("Asia/Riyadh"));
    await syncClientStore(db, pending.ws, pending.client, period.from, period.to);
    return go(`${base}?st=connected#store`);
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: connected ? "zid_first_sync_failed" : "zid_connect_failed", client: pending.client, code: d.code, error: d.message }));
    return go(connected ? `${base}?st=connected&e=store&code=${encodeURIComponent(d.code)}#store`
      : `${base}?e=store&code=${encodeURIComponent(d.code)}#store`);
  }
}
