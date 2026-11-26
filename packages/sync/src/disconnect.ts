import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/**
 * Disconnect one ad account from GLIO (ADR-034). The account and its synced
 * history stay (reports keep working); GLIO stops using it:
 * - status 'disconnected' (daily sync, today view, suggestions and changes skip it);
 * - its stored credential is removed, and the token deleted from the secret store
 *   when no other account uses it;
 * - open change requests for it are expired;
 * - the token is revoked at TikTok only when no other connected account uses it
 *   (one token can cover several ad accounts; revoking would cut them all off).
 * Audited as ad_account.disconnected.
 */

export interface DisconnectResult {
  disconnected: boolean;
  /** True when TikTok confirmed the token is revoked; false when it was kept (shared) or revoking failed. */
  revokedAtPlatform: boolean;
  revokeError: string | null;
  expiredRequests: number;
}

export async function disconnectAdAccount(
  deps: {
    db: SqlExecutor;
    secrets: SecretStore;
    /** Revokes a token at the platform (TikTok: /oauth2/revoke_token/). Omit to skip revoking. */
    revoke?: (accessToken: string) => Promise<void>;
  },
  args: { workspaceId: string; clientId: string; adAccountId: string; userId: string },
): Promise<DisconnectResult> {
  const out = await deps.db.transaction(async (q) => {
    const [account] = await q(
      `select a.id, a.external_id, a.platform, a.status, c.secret_ref
       from public.ad_accounts a left join public.ad_account_credentials c on c.ad_account_id = a.id
       where a.id = $1 and a.workspace_id = $2 and a.client_id = $3 for update of a`,
      [args.adAccountId, args.workspaceId, args.clientId],
    );
    if (!account) return null;
    await q("update public.ad_accounts set status = 'disconnected' where id = $1", [account.id]);
    await q("delete from public.ad_account_credentials where ad_account_id = $1", [account.id]);
    const expired = await q(
      "update public.approval_requests set status = 'expired' where ad_account_id = $1 and status in ('pending', 'approved') returning id",
      [account.id],
    );
    const ref = account.secret_ref as string | null;
    const [shared] = ref
      ? await q("select 1 from public.ad_account_credentials where secret_ref = $1 limit 1", [ref])
      : [undefined];
    return { account, ref, shared: Boolean(shared), expired: expired.length };
  });
  if (!out) return { disconnected: false, revokedAtPlatform: false, revokeError: null, expiredRequests: 0 };

  let revokedAtPlatform = false;
  let revokeError: string | null = null;
  if (out.ref && !out.shared) {
    try {
      if (deps.revoke && !out.ref.startsWith("demo://")) {
        await deps.revoke(await deps.secrets.get(out.ref));
        revokedAtPlatform = true;
      }
    } catch (err) {
      const c = (err as { code?: unknown })?.code;
      revokeError = typeof c === "string" && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : "UNKNOWN";
    }
    await deps.secrets.delete?.(out.ref).catch(() => {});
  }

  await deps.db.query(
    `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1, 'user', $2, 'ad_account.disconnected', 'ad_account', $3, $4)`,
    [args.workspaceId, args.userId, args.adAccountId, JSON.stringify({
      platform: out.account.platform, external_id: out.account.external_id, client_id: args.clientId,
      token: !out.ref ? "none" : out.shared ? "kept_shared" : revokedAtPlatform ? "revoked" : revokeError ? "revoke_failed" : "deleted",
      expired_requests: out.expired,
    })],
  );
  return { disconnected: true, revokedAtPlatform, revokeError, expiredRequests: out.expired };
}
