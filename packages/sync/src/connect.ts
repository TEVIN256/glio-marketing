import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/** Ad platforms GLIO connects (reporting). Only TikTok also has the approval executor. */
export type AdPlatform = "tiktok" | "snapchat";

/** An ad account the owner authorised on the platform. */
export interface AuthorizedAccount {
  externalId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

export interface ConnectArgs {
  workspaceId: string;
  clientId: string;
  /** The signed-in user who completed the platform's authorization (already checked: owner/manager). */
  userId: string;
  platform: AdPlatform;
  /** The token GLIO keeps: TikTok's long-term access token; Snapchat's refresh token (access tokens last 1 hour). */
  accessToken: string;
  /** Where to store the token, from newSecretRef(). */
  secretRef: string;
  accounts: AuthorizedAccount[];
  scopes?: string[];
}

export interface ConnectResult {
  connected: Array<{ adAccountId: string; externalId: string; name: string | null; reconnected: boolean }>;
  /** Already connected to another client in this workspace: left alone. */
  conflicts: Array<{ externalId: string; name: string | null }>;
}

/**
 * Attach the accounts an owner authorised to a client and store the token.
 *
 * - The token goes to the secret store; the database keeps only `secretRef`.
 * - An account already attached to THIS client is reconnected (new token, status active).
 * - An account attached to ANOTHER client in the workspace is not moved (a conflict).
 * - Every connection writes an audit entry. Nothing is stored if nothing can be connected.
 * - A token no longer referenced after a reconnect is deleted from the store.
 */
export async function connectAdAccounts(
  deps: { db: SqlExecutor; secrets: SecretStore },
  args: ConnectArgs,
): Promise<ConnectResult> {
  const result: ConnectResult = { connected: [], conflicts: [] };
  const accounts = dedupe(args.accounts);
  if (accounts.length === 0) return result;

  const replacedRefs = await deps.db.transaction(async (q) => {
    const [client] = await q(
      "select id from public.clients where workspace_id = $1 and id = $2 for update",
      [args.workspaceId, args.clientId],
    );
    if (!client) throw Object.assign(new Error("Client not found in this workspace"), { code: "CLIENT_NOT_FOUND" });

    const plan: Array<{ account: AuthorizedAccount; existingId: string | null }> = [];
    for (const account of accounts) {
      const [row] = await q(
        `select id, client_id from public.ad_accounts
         where workspace_id = $1 and platform = $2 and external_id = $3 for update`,
        [args.workspaceId, args.platform, account.externalId],
      );
      if (row && row.client_id !== args.clientId) result.conflicts.push({ externalId: account.externalId, name: account.name });
      else plan.push({ account, existingId: row?.id ?? null });
    }
    if (plan.length === 0) return [] as string[];

    await deps.secrets.put(args.secretRef, args.accessToken);

    const replaced: string[] = [];
    for (const { account, existingId } of plan) {
      let adAccountId = existingId;
      if (adAccountId) {
        await q(
          `update public.ad_accounts set name = coalesce($2, name), currency = coalesce($3, currency),
                  timezone = coalesce($4, timezone), status = 'active'
           where id = $1`,
          [adAccountId, account.name, account.currency, account.timezone],
        );
        const [old] = await q("select secret_ref from public.ad_account_credentials where ad_account_id = $1", [adAccountId]);
        if (old && old.secret_ref !== args.secretRef) replaced.push(old.secret_ref);
      } else {
        const [created] = await q(
          `insert into public.ad_accounts (workspace_id, client_id, platform, external_id, name, currency, timezone, status)
           values ($1, $2, $3, $4, $5, $6, $7, 'active') returning id`,
          [args.workspaceId, args.clientId, args.platform, account.externalId, account.name, account.currency, account.timezone],
        );
        adAccountId = created!.id as string;
      }
      await q(
        `insert into public.ad_account_credentials (ad_account_id, workspace_id, secret_ref, scopes, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (ad_account_id) do update set secret_ref = excluded.secret_ref, scopes = excluded.scopes, updated_at = now()`,
        [adAccountId, args.workspaceId, args.secretRef, args.scopes ?? []],
      );
      await q(
        `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
         values ($1, 'user', $2, 'ad_account.connected', 'ad_account', $3, $4)`,
        [args.workspaceId, args.userId, adAccountId, JSON.stringify({
          platform: args.platform, external_id: account.externalId, client_id: args.clientId, reconnected: Boolean(existingId),
        })],
      );
      result.connected.push({ adAccountId: adAccountId!, externalId: account.externalId, name: account.name, reconnected: Boolean(existingId) });
    }
    return replaced;
  });

  // Old tokens replaced by this connection: delete them if nothing else uses them.
  for (const ref of new Set(replacedRefs)) {
    const [still] = await deps.db.query("select 1 from public.ad_account_credentials where secret_ref = $1 limit 1", [ref]);
    if (!still) await deps.secrets.delete?.(ref);
  }
  return result;
}

function dedupe(accounts: AuthorizedAccount[]): AuthorizedAccount[] {
  const seen = new Map<string, AuthorizedAccount>();
  for (const a of accounts) {
    const id = a.externalId.trim();
    if (id && !seen.has(id)) seen.set(id, { ...a, externalId: id });
  }
  return [...seen.values()];
}
