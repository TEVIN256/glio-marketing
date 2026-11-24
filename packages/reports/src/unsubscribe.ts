import { randomBytes } from "node:crypto";
import type { SqlExecutor } from "@glio/sync";
import { hashShareToken, isShareToken } from "./shares.ts";

/**
 * One-click unsubscribe from a client's report emails. Every email carries its
 * own random link secret (only its SHA-256 is stored, on the delivery row).
 * The link works without an account and does not expire. Unsubscribing adds
 * the address to report_unsubscribes for that client; future sends skip it.
 */

export const newUnsubscribeToken = (): { token: string; hash: string } => {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashShareToken(token) };
};

export interface UnsubscribeLink {
  workspaceId: string;
  clientId: string;
  clientName: string;
  email: string;
  unsubscribed: boolean;
}

/** What a link points at (null for a malformed or unknown link). */
export async function findUnsubscribeLink(db: SqlExecutor, token: string): Promise<UnsubscribeLink | null> {
  if (!isShareToken(token)) return null;
  const [row] = await db.query(
    `select d.workspace_id, d.client_id, c.name, d.recipient,
            exists (select 1 from public.report_unsubscribes u where u.client_id = d.client_id and u.email = d.recipient) as unsubscribed
     from public.report_deliveries d join public.clients c on c.id = d.client_id
     where d.unsubscribe_token_hash = $1`,
    [hashShareToken(token)],
  );
  if (!row) return null;
  return { workspaceId: row.workspace_id, clientId: row.client_id, clientName: row.name, email: row.recipient, unsubscribed: row.unsubscribed };
}

async function audit(db: SqlExecutor, link: UnsubscribeLink, action: string, via: string): Promise<void> {
  await db.query(
    `insert into public.audit_log (workspace_id, actor_kind, actor_label, action, entity_type, entity_id, metadata)
     values ($1, 'system', 'unsubscribe-link', $2, 'client', $3, $4)`,
    [link.workspaceId, action, link.clientId, JSON.stringify({ email: link.email, via })],
  );
}

/** Stop this client's report emails to the link's address. Idempotent. */
export async function unsubscribe(db: SqlExecutor, token: string, via: "page" | "one-click"): Promise<UnsubscribeLink | null> {
  const link = await findUnsubscribeLink(db, token);
  if (!link) return null;
  if (!link.unsubscribed) {
    const added = await db.query(
      `insert into public.report_unsubscribes (workspace_id, client_id, email) values ($1, $2, $3)
       on conflict do nothing returning email`,
      [link.workspaceId, link.clientId, link.email],
    );
    if (added.length > 0) await audit(db, link, "report.unsubscribed", via);
  }
  return { ...link, unsubscribed: true };
}

/** Undo: the same person, with the same link, gets the emails again. */
export async function resubscribe(db: SqlExecutor, token: string): Promise<UnsubscribeLink | null> {
  const link = await findUnsubscribeLink(db, token);
  if (!link) return null;
  const removed = await db.query(
    "delete from public.report_unsubscribes where client_id = $1 and email = $2 returning email",
    [link.clientId, link.email],
  );
  if (removed.length > 0) await audit(db, link, "report.resubscribed", "page");
  return { ...link, unsubscribed: false };
}

/** Addresses that stopped this client's report emails. */
export async function unsubscribedEmails(db: SqlExecutor, clientId: string): Promise<Set<string>> {
  const rows = await db.query("select email from public.report_unsubscribes where client_id = $1", [clientId]);
  return new Set(rows.map((r) => r.email as string));
}
