import { type NextRequest, NextResponse } from "next/server";
import { todayIn } from "@glio/core";
import { ClaudeCommentaryModel, ResendMailer, runScheduledReports } from "@glio/reports";
import { cronAuthorized } from "@/lib/cron-auth";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { serverDb } from "@/lib/server-db";
import { syncClientTikTok } from "@/lib/tiktok-sync";

export const maxDuration = 60;

/**
 * Daily job (vercel.json, 05:00 UTC = 08:00 Riyadh): email every client report
 * that is due. Only Vercel Cron (with CRON_SECRET) may call it.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), env.cronSecret())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.emailConfigured()) {
    return NextResponse.json({ error: "RESEND_NOT_CONFIGURED" }, { status: 503 });
  }
  const db = serverDb();
  const today = todayIn("Asia/Riyadh");
  try {
    const outcomes = await runScheduledReports(
      {
        db,
        mailer: new ResendMailer(env.resendApiKey()),
        model: env.anthropicConfigured() ? new ClaudeCommentaryModel() : null,
        from: env.reportsFrom(),
        replyTo: env.reportsReplyTo(),
        appUrl: env.appUrl(),
        refresh: async ({ workspaceId, clientId, period }) => {
          if (env.tiktokConfigured()) await syncClientTikTok(db, workspaceId, clientId, period.from, period.to);
        },
      },
      today,
    );
    console.info(JSON.stringify({ event: "scheduled_reports", today, outcomes }));
    return NextResponse.json({ today, outcomes });
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "scheduled_reports_failed", today, code: d.code, error: d.message }));
    return NextResponse.json({ error: d.code }, { status: 500 });
  }
}
