import { DEMO_EXTERNAL_ID, type ReportingConnector, SnapchatConnector, TikTokConnector } from "@glio/connectors";
import { type AdPlatform, type SecretStore, SnapchatAccessTokenStore, type SqlExecutor, VaultSecretStore, reconcile, runSync } from "@glio/sync";
import { env } from "./env";

/** Ad platforms whose app keys are set (so GLIO can sync them). */
export function configuredAdPlatforms(): AdPlatform[] {
  return [...(env.tiktokConfigured() ? ["tiktok" as const] : []), ...(env.snapchatConfigured() ? ["snapchat" as const] : [])];
}

/** Connector and secret store for one platform. Snapchat: 1-hour access tokens minted from the stored refresh token. */
function depsFor(db: SqlExecutor, platform: AdPlatform): { connector: ReportingConnector; secrets: SecretStore } {
  const vault = new VaultSecretStore(db);
  if (platform === "snapchat") {
    const connector = new SnapchatConnector();
    const secrets = new SnapchatAccessTokenStore(vault, (refreshToken) =>
      connector.refresh({ clientId: env.snapchatClientId(), clientSecret: env.snapchatClientSecret(), refreshToken }));
    return { connector, secrets };
  }
  return { connector: new TikTokConnector(), secrets: vault };
}

/**
 * SERVER ONLY. Sync and reconcile a client's connected ad accounts (TikTok and Snapchat; never the
 * demo account) for a period, optionally one platform only. Callers check permissions first.
 * Returns how many accounts were synced; throws on the first failure.
 */
export async function syncClientAds(
  db: SqlExecutor, ws: string, client: string, from: string, to: string,
  kind: "manual" | "backfill" = "manual", platform?: AdPlatform,
): Promise<number> {
  const platforms = configuredAdPlatforms().filter((p) => !platform || p === platform);
  if (platforms.length === 0) return 0;
  const accounts = await db.query(
    `select id, platform from public.ad_accounts
     where workspace_id = $1 and client_id = $2 and platform = any($3::text[]) and status = 'active' and external_id <> $4
     order by platform, created_at`,
    [ws, client, platforms, DEMO_EXTERNAL_ID],
  );
  const byPlatform = new Map<string, ReturnType<typeof depsFor>>();
  for (const account of accounts) {
    if (!byPlatform.has(account.platform)) byPlatform.set(account.platform, depsFor(db, account.platform));
    const deps = { db, ...byPlatform.get(account.platform)! };
    const sync = await runSync(deps, { adAccountId: account.id, kind, dateFrom: from, dateTo: to });
    if (sync.status !== "succeeded") {
      throw Object.assign(new Error(`${account.platform} sync failed: ${sync.errorCode}`), { code: `SYNC_${sync.errorCode ?? "FAILED"}` });
    }
    await reconcile(deps, { syncRunId: sync.syncRunId });
  }
  return accounts.length;
}
