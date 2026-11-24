import { addDays, assertIsoDate, daysInclusive } from "@glio/core";
import type { SqlExecutor } from "@glio/sync";
import type { CommentaryModel } from "./commentary.ts";
import { type EmailLang, renderReportEmail } from "./email.ts";
import type { Mailer } from "./mailer.ts";
import { SHARE_DAYS_DEFAULT, createShare } from "./shares.ts";
import { createReportSnapshot } from "./snapshot.ts";
import { newUnsubscribeToken, unsubscribedEmails } from "./unsubscribe.ts";

/**
 * Emailed reports (M6). A delivery = one report snapshot (exactly what is
 * sent, stored permanently) emailed separately to each recipient (recipients
 * never see each other), with every attempt logged in report_deliveries.
 */

export type Frequency = "off" | "weekly" | "monthly";

/** If a scheduled send was missed (cron down, send failed), keep trying for this many days after. */
export const CATCH_UP_DAYS = 2;

/** ISO weekday of a YYYY-MM-DD date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  assertIsoDate(date);
  const d = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

/**
 * The most recent scheduled send on or before `today` and the period it covers.
 * Weekly: the 7 days before the send day. Monthly: sent on the 1st, covers the previous month.
 */
export function latestScheduledRun(
  schedule: { frequency: Exclude<Frequency, "off">; sendWeekday: number },
  today: string,
): { sendDate: string; period: { from: string; to: string } } {
  assertIsoDate(today);
  if (schedule.frequency === "weekly") {
    const offset = (isoWeekday(today) - schedule.sendWeekday + 7) % 7;
    const sendDate = addDays(today, -offset);
    return { sendDate, period: { from: addDays(sendDate, -7), to: addDays(sendDate, -1) } };
  }
  const sendDate = `${today.slice(0, 8)}01`;
  const to = addDays(sendDate, -1);
  return { sendDate, period: { from: `${to.slice(0, 8)}01`, to } };
}

/** Due when the latest scheduled send is today or at most CATCH_UP_DAYS ago. */
export function scheduledRunIfDue(
  schedule: { frequency: Frequency; sendWeekday: number },
  today: string,
): { sendDate: string; period: { from: string; to: string } } | null {
  if (schedule.frequency === "off") return null;
  const run = latestScheduledRun({ frequency: schedule.frequency, sendWeekday: schedule.sendWeekday }, today);
  return daysInclusive(run.sendDate, today) - 1 <= CATCH_UP_DAYS ? run : null;
}

/** Lower-case, trim, de-duplicate and validate a recipient list (same rule as the database). */
export function normalizeRecipients(input: string[] | string): { valid: string[]; invalid: string[] } {
  const parts = (Array.isArray(input) ? input : input.split(/[\s,;،]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p) && p.length <= 254) {
      if (!valid.includes(p)) valid.push(p);
    } else invalid.push(p);
  }
  return { valid, invalid };
}

export interface DeliverDeps {
  db: SqlExecutor;
  mailer: Mailer;
  model: CommentaryModel | null;
  /** e.g. "GLIO Reports <reports@glioagency.org>" */
  from: string;
  /** Where replies and stop requests go, e.g. info@glioagency.org */
  replyTo: string;
  /** Base URL of the app, e.g. https://www.glioagency.org */
  appUrl: string;
}

export interface DeliverArgs {
  clientId: string;
  period: { from: string; to: string };
  recipients: string[];
  language: EmailLang;
  trigger: "schedule" | "manual";
  /** The user who pressed "send now" (manual sends). */
  sentBy?: string;
}

export interface DeliverResult {
  snapshotId: string | null;
  sent: string[];
  failed: Array<{ recipient: string; code: string }>;
  /** Scheduled sends already delivered earlier for this period. */
  alreadySent: string[];
  /** Recipients who unsubscribed from this client's reports (skipped). */
  unsubscribed: string[];
}

/** Recipients that already received this client's scheduled report for this period. */
async function alreadyDelivered(db: SqlExecutor, clientId: string, period: { from: string; to: string }): Promise<Set<string>> {
  const rows = await db.query(
    `select recipient from public.report_deliveries
     where client_id = $1 and period_from = $2 and period_to = $3 and trigger = 'schedule' and status = 'sent'`,
    [clientId, period.from, period.to],
  );
  return new Set(rows.map((r) => r.recipient as string));
}

async function logDelivery(
  db: SqlExecutor,
  row: {
    workspaceId: string; clientId: string; snapshotId: string | null; period: { from: string; to: string };
    recipient: string; trigger: string; status: "sent" | "failed"; messageId?: string; errorCode?: string; sentBy?: string;
    unsubscribeHash?: string;
  },
): Promise<void> {
  await db.query(
    `insert into public.report_deliveries
       (workspace_id, client_id, snapshot_id, period_from, period_to, recipient, trigger, status, provider_message_id, error_code, sent_by,
        unsubscribe_token_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [row.workspaceId, row.clientId, row.snapshotId, row.period.from, row.period.to, row.recipient, row.trigger, row.status,
      row.messageId ?? null, row.errorCode ?? null, row.sentBy ?? null, row.unsubscribeHash ?? null],
  );
}

function codeOf(err: unknown): string {
  const c = (err as { code?: unknown })?.code;
  return typeof c === "string" && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : "UNKNOWN";
}

/** Snapshot the client's report for the period and email it to each recipient. */
export async function deliverReport(deps: DeliverDeps, args: DeliverArgs): Promise<DeliverResult> {
  const { valid } = normalizeRecipients(args.recipients);
  const [client] = await deps.db.query("select id, workspace_id, name from public.clients where id = $1", [args.clientId]);
  if (!client) throw Object.assign(new Error("Client not found"), { code: "CLIENT_NOT_FOUND" });

  const stopped = await unsubscribedEmails(deps.db, args.clientId);
  const done = args.trigger === "schedule" ? await alreadyDelivered(deps.db, args.clientId, args.period) : new Set<string>();
  const pending = valid.filter((r) => !done.has(r) && !stopped.has(r));
  const result: DeliverResult = {
    snapshotId: null, sent: [], failed: [],
    alreadySent: valid.filter((r) => done.has(r) && !stopped.has(r)), unsubscribed: valid.filter((r) => stopped.has(r)),
  };
  if (pending.length === 0) return result;

  const snapshot = await createReportSnapshot(
    { db: deps.db, model: deps.model },
    {
      clientId: args.clientId, dateFrom: args.period.from, dateTo: args.period.to,
      createdBy: args.sentBy, createdByLabel: args.sentBy ? undefined : "scheduler",
    },
  );
  result.snapshotId = snapshot.snapshotId;
  // One read-only link per delivery, so recipients without a GLIO account can open the full report.
  const share = await createShare(deps.db, { snapshotId: snapshot.snapshotId, days: SHARE_DAYS_DEFAULT, createdByLabel: "report-email" });
  const appUrl = deps.appUrl.replace(/\/$/, "");

  for (const recipient of pending) {
    // Each recipient gets their own unsubscribe link (header for one-click, and in the footer).
    const unsub = newUnsubscribeToken();
    const email = renderReportEmail({
      report: snapshot.report,
      commentary: { ar: snapshot.commentary.ar, en: snapshot.commentary.en, source: snapshot.commentary.source },
      clientName: client.name,
      lang: args.language,
      snapshotUrl: `${appUrl}/w/${client.workspace_id}/c/${client.id}/r/${snapshot.snapshotId}`,
      shareUrl: `${appUrl}/s/${share.token}`,
      shareDays: SHARE_DAYS_DEFAULT,
      contactEmail: deps.replyTo,
      unsubscribeUrl: `${appUrl}/u/${unsub.token}`,
    });
    const base = {
      workspaceId: client.workspace_id as string, clientId: args.clientId, snapshotId: snapshot.snapshotId,
      period: args.period, recipient, trigger: args.trigger, sentBy: args.sentBy, unsubscribeHash: unsub.hash,
    };
    try {
      const { id } = await deps.mailer.send({
        from: deps.from, to: recipient, replyTo: deps.replyTo, subject: email.subject, html: email.html, text: email.text,
        idempotencyKey: `glio-report-${snapshot.snapshotId}-${recipient}`,
        headers: {
          "List-Unsubscribe": `<${appUrl}/api/unsubscribe/${unsub.token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      await logDelivery(deps.db, { ...base, status: "sent", messageId: id });
      result.sent.push(recipient);
    } catch (err) {
      const code = codeOf(err);
      if (code === "23505") { // logged as sent by a concurrent run in the meantime
        result.alreadySent.push(recipient);
        continue;
      }
      await logDelivery(deps.db, { ...base, status: "failed", errorCode: code });
      result.failed.push({ recipient, code });
    }
  }
  return result;
}

export interface ScheduledOutcome {
  clientId: string;
  period: { from: string; to: string };
  status: "sent" | "partial" | "failed" | "already_sent" | "all_unsubscribed";
  sent: number;
  failed: number;
  errorCode?: string;
}

/**
 * The daily job: for every client whose scheduled report is due (or missed in
 * the last CATCH_UP_DAYS), refresh its data, then deliver to the recipients
 * that haven't received it. A failed refresh sends nothing and is logged; the
 * next run retries.
 */
export async function runScheduledReports(
  deps: DeliverDeps & { refresh?: (c: { workspaceId: string; clientId: string; period: { from: string; to: string } }) => Promise<void> },
  today: string,
): Promise<ScheduledOutcome[]> {
  const schedules = await deps.db.query(
    `select workspace_id, client_id, frequency, send_weekday, language, recipients
     from public.report_schedules where frequency <> 'off' and cardinality(recipients) > 0
     order by workspace_id, client_id`,
  );
  const outcomes: ScheduledOutcome[] = [];
  for (const s of schedules) {
    const run = scheduledRunIfDue({ frequency: s.frequency, sendWeekday: Number(s.send_weekday) }, today);
    if (!run) continue;
    const stopped = await unsubscribedEmails(deps.db, s.client_id);
    const recipients = normalizeRecipients(s.recipients as string[]).valid.filter((r) => !stopped.has(r));
    if (recipients.length === 0) {
      outcomes.push({ clientId: s.client_id, period: run.period, status: "all_unsubscribed", sent: 0, failed: 0 });
      continue;
    }
    const done = await alreadyDelivered(deps.db, s.client_id, run.period);
    if (recipients.every((r) => done.has(r))) {
      outcomes.push({ clientId: s.client_id, period: run.period, status: "already_sent", sent: 0, failed: 0 });
      continue;
    }
    try {
      await deps.refresh?.({ workspaceId: s.workspace_id, clientId: s.client_id, period: run.period });
    } catch (err) {
      const code = `REFRESH_${codeOf(err)}`.slice(0, 40);
      for (const recipient of recipients.filter((r) => !done.has(r))) {
        await logDelivery(deps.db, {
          workspaceId: s.workspace_id, clientId: s.client_id, snapshotId: null, period: run.period,
          recipient, trigger: "schedule", status: "failed", errorCode: code,
        });
      }
      outcomes.push({ clientId: s.client_id, period: run.period, status: "failed", sent: 0, failed: recipients.length, errorCode: code });
      continue;
    }
    const r = await deliverReport(deps, {
      clientId: s.client_id, period: run.period, recipients, language: s.language, trigger: "schedule",
    });
    outcomes.push({
      clientId: s.client_id, period: run.period, sent: r.sent.length, failed: r.failed.length,
      status: r.failed.length === 0 ? (r.sent.length > 0 ? "sent" : "already_sent") : r.sent.length > 0 ? "partial" : "failed",
      errorCode: r.failed[0]?.code,
    });
  }
  return outcomes;
}
