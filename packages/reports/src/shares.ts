import { createHash, randomBytes } from "node:crypto";
import type { SqlExecutor } from "@glio/sync";
import type { ReportModel } from "./figures.ts";

/**
 * Read-only share links to one report snapshot, for people without a GLIO
 * account. The link carries a random 256-bit secret; only its SHA-256 is
 * stored. Opening a link never reveals raw platform data or anything beyond
 * the snapshot, its commentary and the client's name.
 */

export const SHARE_DAYS_DEFAULT = 30;
export const SHARE_DAYS_ALLOWED = [7, 30, 90] as const;

export const hashShareToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const isShareToken = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

/** Create a link (server side). Returns the secret token: put it in the URL, never store or log it. */
export async function createShare(
  db: SqlExecutor,
  args: { snapshotId: string; days?: number; createdBy?: string; createdByLabel?: string },
): Promise<{ id: string; token: string; expiresAt: string }> {
  const days = SHARE_DAYS_ALLOWED.includes(args.days as 7) ? args.days! : SHARE_DAYS_DEFAULT;
  if (!args.createdBy && !args.createdByLabel) throw new Error("A share needs a creator (user id or label)");
  const token = randomBytes(32).toString("base64url");
  const [row] = await db.query(
    `insert into public.report_shares (workspace_id, client_id, snapshot_id, token_hash, created_by, created_by_label, expires_at)
     select s.workspace_id, s.client_id, s.id, $2, $3, $4, now() + ($5 || ' days')::interval
     from public.report_snapshots s where s.id = $1
     returning id, expires_at::text`,
    [args.snapshotId, hashShareToken(token), args.createdBy ?? null, args.createdByLabel ?? null, String(days)],
  );
  if (!row) throw Object.assign(new Error("Report not found"), { code: "SNAPSHOT_NOT_FOUND" });
  return { id: row.id as string, token, expiresAt: row.expires_at as string };
}

export interface SharedReport {
  clientName: string;
  report: ReportModel;
  commentary: { ar: string; en: string; source: "llm" | "template" };
  createdAt: string;
  expiresAt: string;
}

/** Open a link: valid, unexpired, unrevoked -> the report (and the view is counted); anything else -> null. */
export async function openShare(db: SqlExecutor, token: string): Promise<SharedReport | null> {
  if (!isShareToken(token)) return null;
  const [r] = await db.query(
    `select sh.id, c.name as client_name, s.report, s.created_at::text as created_at, sh.expires_at::text as expires_at,
            a.text_ar, a.text_en, a.source
     from public.report_shares sh
     join public.report_snapshots s on s.id = sh.snapshot_id
     join public.ai_commentary a on a.id = s.commentary_id
     join public.clients c on c.id = sh.client_id
     where sh.token_hash = $1 and sh.revoked_at is null and sh.expires_at > now()`,
    [hashShareToken(token)],
  );
  if (!r) return null;
  await db.query("update public.report_shares set view_count = view_count + 1, last_viewed_at = now() where id = $1", [r.id]);
  return {
    clientName: r.client_name,
    report: r.report as ReportModel,
    commentary: { ar: r.text_ar, en: r.text_en, source: r.source },
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}
