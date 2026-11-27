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
       union all select 1 from public.pending_ad_connections where secret_ref = $1
       union all select 1 from public.store_credentials where secret_ref = $1 limit 1`,
      [ref],
    );
    if (used || ref.startsWith("demo://")) continue;
    // `revoke` is the ad platform's; a store's tokens (vault:glio/zid/…) are never sent to it.
    if (deps.revoke && !isStoreRef(ref)) {
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

/** A store platform's token bundle (Zid), not an ad platform token. */
export function isStoreRef(ref: string): boolean {
  return ref.startsWith("vault:glio/zid/");
}
