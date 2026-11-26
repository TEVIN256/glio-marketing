import { type NextRequest, NextResponse } from "next/server";
import { DEMO_EXTERNAL_ID } from "@glio/connectors";
import { addDays, todayIn } from "@glio/core";
import { ClaudeCommentaryModel, ResendMailer, runScheduledReports } from "@glio/reports";
import { VaultSecretStore, purgeExpiredData, purgeExpiredPendingConnections, suggestForClients } from "@glio/sync";
import { cronAuthorized } from "@/lib/cron-auth";
import { notifyApprovals } from "@/lib/notify-run";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { serverDb } from "@/lib/server-db";
import { syncClientTikTok } from "@/lib/tiktok-sync";

export const maxDuration = 60;

/**
 * Daily job (vercel.json, 05:00 UTC = 08:00 Riyadh). Only Vercel Cron (with CRON_SECRET) may call it.
 *  1. Refresh the last 7 days of TikTok data for clients with connected (non-demo) accounts.
 *  2. Run GLIO's suggestion rules for every client (proposals only; nothing is applied).
 *  3. Email owners/managers about requests waiting for approval (each announced once).
 *  4. Email the scheduled reports that are due.
 * Each step is isolated: one failing doesn't stop the next.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), env.cronSecret())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = serverDb();
  const today = todayIn("Asia/Riyadh");
  const yesterday = addDays(today, -1);
  const result: Record<string, unknown> = { today };

  // 1. Refresh connected accounts
  const refreshed: Array<{ client: string; ok: boolean; code?: string }> = [];
  if (env.tiktokConfigured()) {
    const clients = await db.query(
      `select distinct workspace_id, client_id from public.ad_accounts
       where platform = 'tiktok' and status = 'active' and external_id <> $1`,
      [DEMO_EXTERNAL_ID],
    );
    for (const c of clients) {
      try {
        await syncClientTikTok(db, c.workspace_id, c.client_id, addDays(yesterday, -6), yesterday);
        refreshed.push({ client: c.client_id, ok: true });
      } catch (err) {
        refreshed.push({ client: c.client_id, ok: false, code: describeError(err).code });
      }
    }
  }
  result.refreshed = refreshed;

  // 2. Suggestions
  try {
    const clients = await db.query("select id from public.clients");
    const out = await suggestForClients({ db, secrets: new VaultSecretStore(db) }, { clientIds: clients.map((c) => c.id), yesterday });
    result.suggestions = { created: out.reduce((n, r) => n + r.created.length, 0), errors: out.filter((r) => r.error).length };
  } catch (err) {
    result.suggestions = { error: describeError(err).code };
  }

  // 3. Approval notifications
  result.notified = (await notifyApprovals()).map((r) => ({ workspace: r.workspaceId, items: r.items, sent: r.sent, failed: r.failed }));

  // 4. Scheduled report emails
  if (env.emailConfigured()) {
    try {
      result.reports = await runScheduledReports(
        {
          db, mailer: new ResendMailer(env.resendApiKey()),
          model: env.anthropicConfigured() ? new ClaudeCommentaryModel() : null,
          from: env.reportsFrom(), replyTo: env.reportsReplyTo(), appUrl: env.appUrl(),
          refresh: async ({ workspaceId, clientId, period }) => {
            if (env.tiktokConfigured()) await syncClientTikTok(db, workspaceId, clientId, period.from, period.to);
          },
        },
        today,
      );
    } catch (err) {
      result.reports = { error: describeError(err).code };
    }
  } else {
    result.reports = { error: "RESEND_NOT_CONFIGURED" };
  }

  // 5. Retention: delete personal data past its retention period (migration 0013)
  try {
    result.purged = {
      ...(await purgeExpiredData(db)),
      pending_ad_connections: await purgeExpiredPendingConnections({ db, secrets: new VaultSecretStore(db) }),
    };
  } catch (err) {
    result.purged = { error: describeError(err).code };
  }

  console.info(JSON.stringify({ event: "daily_job", ...result }));
  return NextResponse.json(result);
}
