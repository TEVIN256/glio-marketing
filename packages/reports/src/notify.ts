import { createHash } from "node:crypto";
import type { SqlExecutor } from "@glio/sync";
import type { Mailer } from "./mailer.ts";

/**
 * "Changes waiting for your approval" emails to a workspace's owners and
 * managers (the only people who can approve). Each pending request is
 * announced once (approval_requests.notified_at). People who turned the email
 * off (notification_settings.approvals_email = false) are skipped. The email
 * itself is rendered by the caller (the web app owns the wording).
 */

export interface PendingItem {
  id: string;
  workspace_id: string;
  client_id: string;
  client_name: string;
  kind: string;
  payload: Record<string, unknown> | null;
  reason: string | null;
  target_name: string | null;
  target_id: string | null;
  currency: string | null;
  requested_by: string | null;
  requested_by_agent: string | null;
  created_at: string;
}

export interface RenderedNotification {
  subject: string;
  html: string;
  text: string;
}

export interface NotifyDeps {
  db: SqlExecutor;
  mailer: Mailer;
  from: string;
  replyTo: string;
  render: (args: { workspaceId: string; workspaceName: string; items: PendingItem[] }) => RenderedNotification;
}

export interface NotifyResult {
  workspaceId: string;
  items: number;
  recipients: number;
  sent: number;
  failed: number;
}

/**
 * Announce every pending, unexpired, not-yet-announced request, per workspace.
 * `workspaceId` limits it to one workspace; `excludeUserId` skips the person
 * whose own action created the requests (they already know). Requests are
 * marked as announced when at least one email was sent, or when nobody needs
 * telling; if every send failed they stay unmarked and are retried next time.
 */
export async function notifyPendingApprovals(
  deps: NotifyDeps,
  args: { workspaceId?: string; excludeUserId?: string } = {},
): Promise<NotifyResult[]> {
  const items = (await deps.db.query(
    `select r.id, r.workspace_id, r.client_id, c.name as client_name, r.kind, r.payload, r.reason, r.target_name, r.target_id,
            a.currency, r.requested_by, r.requested_by_agent, r.created_at::text
     from public.approval_requests r
     join public.clients c on c.id = r.client_id
     left join public.ad_accounts a on a.id = r.ad_account_id
     where r.status = 'pending' and r.notified_at is null and (r.expires_at is null or r.expires_at > now())
       and ($1::uuid is null or r.workspace_id = $1)
     order by r.workspace_id, r.created_at`,
    [args.workspaceId ?? null],
  )) as PendingItem[];

  const results: NotifyResult[] = [];
  for (const ws of new Set(items.map((i) => i.workspace_id))) {
    const wsItems = items.filter((i) => i.workspace_id === ws);
    const ids = wsItems.map((i) => i.id);
    const [workspace] = await deps.db.query("select name from public.workspaces where id = $1", [ws]);
    const people = await deps.db.query(
      `select u.id, u.email from public.memberships m
       join auth.users u on u.id = m.user_id
       left join public.notification_settings s on s.workspace_id = m.workspace_id and s.user_id = m.user_id
       where m.workspace_id = $1 and m.role in ('owner', 'manager') and coalesce(s.approvals_email, true)
         and u.email is not null and ($2::uuid is null or u.id <> $2)
       order by u.email`,
      [ws, args.excludeUserId ?? null],
    );
    const result: NotifyResult = { workspaceId: ws, items: wsItems.length, recipients: people.length, sent: 0, failed: 0 };

    if (people.length > 0) {
      const email = deps.render({ workspaceId: ws, workspaceName: workspace?.name ?? "", items: wsItems });
      const batch = createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16);
      for (const p of people) {
        try {
          await deps.mailer.send({
            from: deps.from, to: p.email, replyTo: deps.replyTo, subject: email.subject, html: email.html, text: email.text,
            idempotencyKey: `glio-approvals-${batch}-${p.id}`,
          });
          result.sent++;
        } catch {
          result.failed++;
        }
      }
    }

    if (people.length === 0 || result.sent > 0) {
      await deps.db.query("update public.approval_requests set notified_at = now() where id = any($1::uuid[]) and notified_at is null", [ids]);
      await deps.db.query(
        `insert into public.audit_log (workspace_id, actor_kind, actor_label, action, entity_type, entity_id, metadata)
         values ($1::uuid, 'system', 'notifier', 'approval.notified', 'workspace', $1::text, $2)`,
        [ws, JSON.stringify({ requests: ids.length, recipients: people.length, sent: result.sent, failed: result.failed })],
      );
    }
    results.push(result);
  }
  return results;
}
