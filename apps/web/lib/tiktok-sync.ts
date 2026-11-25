import { DEMO_EXTERNAL_ID, TikTokConnector } from "@glio/connectors";
import { type SqlExecutor, VaultSecretStore, reconcile, runSync } from "@glio/sync";

/**
 * SERVER ONLY. Sync and reconcile a client's connected TikTok accounts (not
 * the demo account) for a period. Callers check permissions first.
 * Returns how many accounts were synced; throws on the first failure.
 */
export async function syncClientTikTok(
  db: SqlExecutor, ws: string, client: string, from: string, to: string, kind: "manual" | "backfill" = "manual",
): Promise<number> {
  const accounts = await db.query(
    `select id from public.ad_accounts
     where workspace_id = $1 and client_id = $2 and platform = 'tiktok' and status = 'active' and external_id <> $3`,
    [ws, client, DEMO_EXTERNAL_ID],
  );
  const deps = { db, connector: new TikTokConnector(), secrets: new VaultSecretStore(db) };
  for (const account of accounts) {
    const sync = await runSync(deps, { adAccountId: account.id, kind, dateFrom: from, dateTo: to });
    if (sync.status !== "succeeded") {
      throw Object.assign(new Error(`TikTok sync failed: ${sync.errorCode}`), { code: `SYNC_${sync.errorCode ?? "FAILED"}` });
    }
    await reconcile(deps, { syncRunId: sync.syncRunId });
  }
  return accounts.length;
}
