import { ResendMailer, notifyPendingApprovals } from "@glio/reports";
import { renderApprovalEmail } from "./approval-email";
import { env } from "./env";
import { describeError } from "./errors";
import { serverDb } from "./server-db";

/**
 * SERVER ONLY. Email owners/managers about pending approval requests not yet
 * announced. Never throws: a notification problem must not break the action
 * that created the requests. Does nothing when email isn't configured (the
 * requests stay unannounced and go out once it is).
 */
export async function notifyApprovals(args: { workspaceId?: string; excludeUserId?: string } = {}) {
  if (!env.emailConfigured()) return [];
  try {
    const results = await notifyPendingApprovals(
      {
        db: serverDb(), mailer: new ResendMailer(env.resendApiKey()), from: env.reportsFrom(), replyTo: env.reportsReplyTo(),
        render: (r) => renderApprovalEmail({ ...r, appUrl: env.appUrl(), contactEmail: env.reportsReplyTo() }),
      },
      args,
    );
    if (results.length) console.info(JSON.stringify({ event: "approvals_notified", results }));
    return results;
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "approvals_notify_failed", code: d.code, error: d.message }));
    return [];
  }
}
