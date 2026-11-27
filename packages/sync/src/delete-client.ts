import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";
import { dropUnusedTokens } from "./tokens.ts";

/**
 * Delete a client and everything GLIO holds about it (ADR-029): ad accounts,
 * platform tokens (also removed from the secret store), synced raw data and
 * metrics, reconciliation checks, reports, commentary, share links, email
 * schedules and the delivery log, unsubscribes, approvals and suggestions,
 * settings, and client-viewer memberships. All of it goes through the
 * database's ON DELETE CASCADE in one transaction.
 *
 * Kept on purpose: the audit log (append-only; it records this deletion with
 * the client's name and how many records were removed, never their content).
 * The caller must already have checked that the user is a workspace owner.
 */

/** Tables counted in the deletion summary (everything with a client_id is removed). */
const COUNTED = [
  "ad_accounts", "raw_platform_payloads", "metric_daily", "report_snapshots", "report_deliveries", "approval_requests",
] as const;

export interface DeleteClientResult {
  deleted: boolean;
  clientName: string | null;
  counts: Record<string, number>;
  /** Tokens removed from the secret store; failures are counted, never thrown after the data is gone. */
  secretsDeleted: number;
  secretsFailed: number;
}

export async function deleteClientData(
  deps: { db: SqlExecutor; secrets: SecretStore; revoke?: (accessToken: string) => Promise<void> },
  args: { workspaceId: string; clientId: string; deletedBy: string },
): Promise<DeleteClientResult> {
  const out = await deps.db.transaction(async (q) => {
    const [client] = await q(
      "select id, name from public.clients where id = $1 and workspace_id = $2 for update",
      [args.clientId, args.workspaceId],
    );
    if (!client) return null;
    const counts: Record<string, number> = {};
    for (const table of COUNTED) {
      const [row] = await q(`select count(*)::int as n from public.${table} where client_id = $1`, [args.clientId]);
      counts[table] = row!.n as number;
    }
    const refs = (await q(
      `select distinct c.secret_ref from public.ad_account_credentials c
       join public.ad_accounts a on a.id = c.ad_account_id where a.client_id = $1
       union
       select secret_ref from public.pending_ad_connections where client_id = $1
       union
       select c.secret_ref from public.store_credentials c
       join public.store_connections s on s.id = c.connection_id where s.client_id = $1`,
      [args.clientId],
    )).map((r) => r.secret_ref as string);

    await q("delete from public.clients where id = $1 and workspace_id = $2", [args.clientId, args.workspaceId]);
    await q(
      `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
       values ($1, 'user', $2, 'client.deleted', 'client', $3, $4)`,
      [args.workspaceId, args.deletedBy, args.clientId, JSON.stringify({ name: client.name, counts })],
    );
    return { name: client.name as string, counts, refs };
  });
  if (!out) return { deleted: false, clientName: null, counts: {}, secretsDeleted: 0, secretsFailed: 0 };

  // Tokens nothing else uses any more: revoked at the platform (best effort) and deleted, after the data
  // is gone, so a failure here can't leave a half-deleted client.
  const t = await dropUnusedTokens(deps, out.refs);
  const secretsDeleted = t.deleted;
  const secretsFailed = t.failed;
  return { deleted: true, clientName: out.name, counts: out.counts, secretsDeleted, secretsFailed };
}

/** Daily retention purge (migration 0013): what was deleted, per table. */
export async function purgeExpiredData(db: SqlExecutor): Promise<Record<string, number>> {
  const [row] = await db.query("select public.purge_expired_data() as result");
  return row!.result as Record<string, number>;
}
