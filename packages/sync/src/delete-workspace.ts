import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";
import { dropUnusedTokens } from "./tokens.ts";

/**
 * Delete a whole workspace (ADR-037): every client and all their data, ad
 * accounts, members, invitations and settings, through ON DELETE CASCADE in one
 * transaction; then its platform tokens are revoked (best effort) and deleted
 * from the secret store. The audit log is kept (append-only, no foreign key to
 * workspaces) and records the deletion with the name and counts only.
 * The caller must already have checked that the user is an owner.
 */
export async function deleteWorkspaceData(
  deps: { db: SqlExecutor; secrets: SecretStore; revoke?: (accessToken: string) => Promise<void> },
  args: { workspaceId: string; deletedBy: string },
): Promise<{ deleted: boolean; name: string | null; counts: Record<string, number>; tokens: { deleted: number; revoked: number; failed: number } }> {
  const out = await deps.db.transaction(async (q) => {
    const [ws] = await q("select id, name from public.workspaces where id = $1 for update", [args.workspaceId]);
    if (!ws) return null;
    const counts: Record<string, number> = {};
    for (const table of ["clients", "memberships", "ad_accounts", "metric_daily", "report_snapshots"] as const) {
      const [r] = await q(`select count(*)::int as n from public.${table} where workspace_id = $1`, [args.workspaceId]);
      counts[table] = r!.n as number;
    }
    const refs = (await q(
      `select secret_ref from public.ad_account_credentials where workspace_id = $1
       union select secret_ref from public.pending_ad_connections where workspace_id = $1
       union select secret_ref from public.store_credentials where workspace_id = $1`,
      [args.workspaceId],
    )).map((r) => r.secret_ref as string);
    await q(
      `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
       values ($1::uuid, 'user', $2, 'workspace.deleted', 'workspace', $1::text, $3)`,
      [args.workspaceId, args.deletedBy, JSON.stringify({ name: ws.name, counts })],
    );
    await q("delete from public.workspaces where id = $1", [args.workspaceId]);
    return { name: ws.name as string, counts, refs };
  });
  if (!out) return { deleted: false, name: null, counts: {}, tokens: { deleted: 0, revoked: 0, failed: 0 } };
  const tokens = await dropUnusedTokens(deps, out.refs);
  return { deleted: true, name: out.name, counts: out.counts, tokens };
}

/**
 * Workspaces that stop a person deleting their account: those where they are
 * the only owner. (Other members would be left without an owner; a solo
 * workspace must be deleted first, explicitly.)
 */
export async function accountDeletionBlockers(db: SqlExecutor, userId: string): Promise<Array<{ id: string; name: string; members: number }>> {
  return (await db.query(
    `select w.id, w.name, (select count(*)::int from public.memberships m2 where m2.workspace_id = w.id) as members
     from public.memberships m join public.workspaces w on w.id = m.workspace_id
     where m.user_id = $1 and m.role = 'owner'
       and not exists (select 1 from public.memberships o where o.workspace_id = w.id and o.role = 'owner' and o.user_id <> $1)
     order by w.name`,
    [userId],
  )) as Array<{ id: string; name: string; members: number }>;
}

/**
 * Before the sign-in record is deleted: cancel the person's open invitations and
 * record the departure in each workspace they belong to. Their memberships go
 * with the account (ON DELETE CASCADE); past actions keep their id (migration 0018).
 */
export async function prepareAccountDeletion(db: SqlExecutor, userId: string): Promise<{ workspaces: number; invitationsCancelled: number }> {
  return db.transaction(async (q) => {
    const blockers = await q(
      `select 1 from public.memberships m where m.user_id = $1 and m.role = 'owner'
         and not exists (select 1 from public.memberships o where o.workspace_id = m.workspace_id and o.role = 'owner' and o.user_id <> $1)
       limit 1`,
      [userId],
    );
    if (blockers.length) throw Object.assign(new Error("Only owner of a workspace"), { code: "SOLE_OWNER" });
    const cancelled = await q(
      "update public.invitations set revoked_at = now() where invited_by = $1 and accepted_at is null and revoked_at is null returning id",
      [userId],
    );
    const ws = await q("select workspace_id from public.memberships where user_id = $1", [userId]);
    for (const w of ws) {
      await q(
        `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id)
         values ($1, 'user', $2::uuid, 'member.account_deleted', 'user', $2::text)`,
        [w.workspace_id, userId],
      );
    }
    return { workspaces: ws.length, invitationsCancelled: cancelled.length };
  });
}
