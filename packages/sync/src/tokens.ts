import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/**
 * After ad accounts are removed: for each token reference nothing uses any more,
 * revoke it at the platform (best effort) and delete it from the secret store.
 * Tokens still used by another connected account are left alone.
 */
export async function dropUnusedTokens(
  deps: { db: SqlExecutor; secrets: SecretStore; revoke?: (accessToken: string) => Promise<void> },
  refs: string[],
): Promise<{ deleted: number; revoked: number; failed: number }> {
  let deleted = 0;
  let revoked = 0;
  let failed = 0;
  for (const ref of new Set(refs)) {
    const [used] = await deps.db.query(
      `select 1 from public.ad_account_credentials where secret_ref = $1
       union all select 1 from public.pending_ad_connections where secret_ref = $1 limit 1`,
      [ref],
    );
    if (used || ref.startsWith("demo://")) continue;
    if (deps.revoke) {
      try {
        await deps.revoke(await deps.secrets.get(ref));
        revoked += 1;
      } catch {
        failed += 1;
      }
    }
    try {
      await deps.secrets.delete?.(ref);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, revoked, failed };
}
