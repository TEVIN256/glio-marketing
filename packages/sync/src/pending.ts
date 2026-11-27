import { type AdPlatform, type AuthorizedAccount, type ConnectResult, connectAdAccounts } from "./connect.ts";
import { type SecretStore, newSecretRef } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/**
 * Choosing which ad accounts to connect (migration 0015). TikTok's authorization
 * grants every ad account the login can reach; when that is more than one, the
 * token goes to the secret store right away, the authorised accounts are kept in
 * pending_ad_connections (server only), and the owner/manager picks which ones
 * to attach to the client. Nothing is attached until they confirm.
 */

export const PENDING_MINUTES = 30;

type Deps = { db: SqlExecutor; secrets: SecretStore };

export interface PendingAccount extends AuthorizedAccount {
  /** this_client: already attached here (reconnect); other_client: attached to another client in the workspace. */
  state: "new" | "this_client" | "other_client";
  otherClientName: string | null;
}

export interface PendingConnection {
  id: string;
  workspaceId: string;
  clientId: string;
  platform: AdPlatform;
  expiresAt: string;
  accounts: PendingAccount[];
}

export async function createPendingConnection(
  deps: Deps,
  args: { workspaceId: string; clientId: string; userId: string; platform: AdPlatform; accessToken: string; accounts: AuthorizedAccount[] },
): Promise<string> {
  const secretRef = newSecretRef(args.platform);
  await deps.secrets.put(secretRef, args.accessToken);
  const accounts = args.accounts.map((a) => ({ externalId: a.externalId, name: a.name, currency: a.currency, timezone: a.timezone }));
  try {
    const [row] = await deps.db.query(
      `insert into public.pending_ad_connections (workspace_id, client_id, user_id, platform, secret_ref, accounts, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval) returning id`,
      [args.workspaceId, args.clientId, args.userId, args.platform, secretRef, JSON.stringify(accounts), String(PENDING_MINUTES)],
    );
    return row!.id as string;
  } catch (err) {
    await deps.secrets.delete?.(secretRef).catch(() => {});
    throw err;
  }
}

/** The pending connection, only for the user who started it and only while it is valid; null otherwise. */
export async function loadPendingConnection(db: SqlExecutor, args: { id: string; userId: string }): Promise<PendingConnection | null> {
  if (!/^[0-9a-f-]{36}$/i.test(args.id)) return null;
  const [row] = await db.query(
    `select id, workspace_id, client_id, platform, accounts, expires_at::text as expires_at
     from public.pending_ad_connections where id = $1 and user_id = $2 and expires_at > now()`,
    [args.id, args.userId],
  );
  if (!row) return null;
  const authorised = row.accounts as AuthorizedAccount[];
  const existing = await db.query(
    `select a.external_id, a.client_id, c.name from public.ad_accounts a join public.clients c on c.id = a.client_id
     where a.workspace_id = $1 and a.platform = $2 and a.external_id = any($3::text[])`,
    [row.workspace_id, row.platform, authorised.map((a) => a.externalId)],
  );
  const byId = new Map(existing.map((e) => [e.external_id as string, e]));
  return {
    id: row.id, workspaceId: row.workspace_id, clientId: row.client_id, platform: row.platform, expiresAt: row.expires_at,
    accounts: authorised.map((a) => {
      const e = byId.get(a.externalId);
      const state = !e ? "new" : e.client_id === row.client_id ? "this_client" : "other_client";
      return { ...a, state, otherClientName: state === "other_client" ? (e!.name as string) : null };
    }),
  };
}

/** Delete a token nothing uses any more. */
async function dropUnusedSecret(deps: Deps, ref: string): Promise<void> {
  const [used] = await deps.db.query("select 1 from public.ad_account_credentials where secret_ref = $1 limit 1", [ref]);
  if (!used) await deps.secrets.delete?.(ref);
}

/** Take the pending row (once: a second submit finds nothing). */
async function takePending(db: SqlExecutor, args: { id: string; userId: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(args.id)) return null;
  const [row] = await db.query(
    `delete from public.pending_ad_connections where id = $1 and user_id = $2 and expires_at > now()
     returning workspace_id, client_id, platform, secret_ref, accounts`,
    [args.id, args.userId],
  );
  return row ?? null;
}

/**
 * Attach only the chosen accounts. Ids not in the authorised list are refused
 * (no connecting an account TikTok didn't grant). Choosing none = cancel.
 */
export async function confirmPendingConnection(
  deps: Deps,
  args: { id: string; userId: string; externalIds: string[] },
): Promise<(ConnectResult & { workspaceId: string; clientId: string }) | null> {
  const row = await takePending(deps.db, args);
  if (!row) return null;
  const authorised = row.accounts as AuthorizedAccount[];
  const chosen = authorised.filter((a) => args.externalIds.includes(a.externalId));
  try {
    if (args.externalIds.some((id) => !authorised.some((a) => a.externalId === id))) {
      throw Object.assign(new Error("An account that wasn't authorised was submitted"), { code: "ACCOUNT_NOT_AUTHORISED" });
    }
    const result = chosen.length === 0
      ? { connected: [], conflicts: [] }
      : await connectAdAccounts(deps, {
          workspaceId: row.workspace_id, clientId: row.client_id, userId: args.userId, platform: row.platform,
          accessToken: await deps.secrets.get(row.secret_ref), secretRef: row.secret_ref, accounts: chosen,
        });
    return { ...result, workspaceId: row.workspace_id, clientId: row.client_id };
  } finally {
    await dropUnusedSecret(deps, row.secret_ref);
  }
}

export async function cancelPendingConnection(deps: Deps, args: { id: string; userId: string }): Promise<boolean> {
  const row = await takePending(deps.db, args);
  if (!row) return false;
  await dropUnusedSecret(deps, row.secret_ref);
  return true;
}

/** Daily: expired pending connections and their tokens. */
export async function purgeExpiredPendingConnections(deps: Deps): Promise<number> {
  const rows = await deps.db.query("delete from public.pending_ad_connections where expires_at <= now() returning secret_ref");
  for (const r of rows) await dropUnusedSecret(deps, r.secret_ref as string).catch(() => {});
  return rows.length;
}
