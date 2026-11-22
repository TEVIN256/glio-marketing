"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { DEMO_EXTERNAL_ID, TikTokConnector, demoTikTokFetch } from "@glio/connectors";
import { ClaudeCommentaryModel, ResendMailer, createReportSnapshot, deliverReport, normalizeRecipients } from "@glio/reports";
import { InMemorySecretStore, reconcile, runSync } from "@glio/sync";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { OAUTH_MAX_AGE_SECONDS, TIKTOK_OAUTH_COOKIE, newPendingConnection } from "@/lib/oauth-state";
import { serverDb } from "@/lib/server-db";
import { syncClientTikTok } from "@/lib/tiktok-sync";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Create a report snapshot. Allowed for owners, managers and analysts (checked under the user's RLS first). */
export async function generateReport(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const from = String(formData.get("from"));
  const to = String(formData.get("to"));
  const base = `/w/${ws}/c/${client}`;
  if (!ISO.test(from) || !ISO.test(to) || to < from) redirect(`${base}?e=period`);

  const access = await clientAccess(ws, client);
  if (!access.canGenerate) redirect(`${base}?e=forbidden`);

  let snapshotId: string | null = null;
  let failure: string | null = null;
  try {
    const result = await createReportSnapshot(
      { db: serverDb(), model: env.anthropicConfigured() ? new ClaudeCommentaryModel() : null },
      { clientId: client, dateFrom: from, dateTo: to, createdBy: access.user.id },
    );
    snapshotId = result.snapshotId;
  } catch (err) {
    const d = describeError(err);
    failure = d.code;
    console.error(JSON.stringify({ event: "report_failed", client, code: d.code, error: d.message }));
  }
  // redirect() must be called outside try/catch.
  redirect(snapshotId ? `${base}/r/${snapshotId}` : `${base}?e=report&code=${encodeURIComponent(failure ?? "UNKNOWN")}`);
}

/**
 * DEMO ONLY (GLIO_DEMO_MODE=1): attach a synthetic TikTok account to this
 * client and sync + reconcile the chosen period with fake numbers.
 * Owners and managers only.
 */
export async function loadDemoData(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const from = String(formData.get("from"));
  const to = String(formData.get("to"));
  const base = `/w/${ws}/c/${client}`;
  if (!env.demoMode()) redirect(base);
  if (!ISO.test(from) || !ISO.test(to) || to < from) redirect(`${base}?e=period`);
  const access = await clientAccess(ws, client);
  if (!access.canManage) redirect(`${base}?e=forbidden`);

  let failure: string | null = null;
  try {
    await syncDemo(ws, client, from, to);
  } catch (err) {
    const d = describeError(err);
    failure = d.code;
    console.error(JSON.stringify({ event: "demo_sync_failed", client, code: d.code, error: d.message }));
  }
  // redirect() must be called outside try/catch.
  redirect(failure ? `${base}?e=demo&code=${encodeURIComponent(failure)}` : `${base}?from=${from}&to=${to}`);
}

async function syncDemo(ws: string, client: string, from: string, to: string) {
  const db = serverDb();
  let [account] = await db.query(
    "select id from public.ad_accounts where client_id = $1 and platform = 'tiktok' and external_id = $2",
    [client, DEMO_EXTERNAL_ID],
  );
  if (!account) {
    [account] = await db.query(
      `insert into public.ad_accounts (workspace_id, client_id, platform, external_id, name, currency, timezone, status)
       values ($1, $2, 'tiktok', $3, 'Demo TikTok account (synthetic)', 'SAR', 'Asia/Riyadh', 'active') returning id`,
      [ws, client, DEMO_EXTERNAL_ID],
    );
    await db.query(
      "insert into public.ad_account_credentials (ad_account_id, workspace_id, secret_ref) values ($1, $2, 'demo://synthetic')",
      [account!.id, ws],
    );
  }
  const secrets = new InMemorySecretStore();
  await secrets.put("demo://synthetic", "demo-token-not-real");
  const deps = { db, connector: new TikTokConnector({ fetch: demoTikTokFetch }), secrets };
  const sync = await runSync(deps, { adAccountId: account!.id, kind: "manual", dateFrom: from, dateTo: to });
  if (sync.status !== "succeeded") {
    throw Object.assign(new Error(`Demo sync failed: ${sync.errorCode}`), { code: `SYNC_${sync.errorCode ?? "FAILED"}` });
  }
  await reconcile(deps, { syncRunId: sync.syncRunId });
}

/**
 * Start connecting TikTok for this client (owners and managers): remember the
 * request in a short-lived httpOnly cookie and send the user to TikTok's
 * authorization page. TikTok returns to /integrations/tiktok/callback.
 */
export async function connectTikTok(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const base = `/w/${ws}/c/${client}`;
  const access = await clientAccess(ws, client);
  if (!access.canManage) redirect(`${base}?e=forbidden`);
  if (!env.tiktokConfigured()) redirect(`${base}?e=tiktok&code=TIKTOK_NOT_CONFIGURED`);

  const { state, cookie } = newPendingConnection(ws, client);
  const secure = ((await headers()).get("x-forwarded-proto") ?? "https") === "https";
  (await cookies()).set(TIKTOK_OAUTH_COOKIE, cookie, {
    httpOnly: true, secure, sameSite: "lax", path: "/integrations/tiktok", maxAge: OAUTH_MAX_AGE_SECONDS,
  });
  redirect(TikTokConnector.authorizationUrl({ appId: env.tiktokAppId(), redirectUri: env.tiktokRedirectUri(), state }));
}

/**
 * Sync the client's connected TikTok accounts (not the demo one) for the chosen
 * period, then reconcile each against TikTok's account totals. Owners and managers.
 */
export async function syncTikTok(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const from = String(formData.get("from"));
  const to = String(formData.get("to"));
  const base = `/w/${ws}/c/${client}`;
  if (!ISO.test(from) || !ISO.test(to) || to < from) redirect(`${base}?e=period`);
  const access = await clientAccess(ws, client);
  if (!access.canManage) redirect(`${base}?e=forbidden`);

  let failure: string | null = null;
  try {
    const synced = await syncClientTikTok(serverDb(), ws, client, from, to);
    if (synced === 0) throw Object.assign(new Error("No connected TikTok account"), { code: "TIKTOK_NO_ACCOUNTS" });
  } catch (err) {
    const d = describeError(err);
    failure = d.code;
    console.error(JSON.stringify({ event: "tiktok_sync_failed", client, code: d.code, error: d.message }));
  }
  // redirect() must be called outside try/catch.
  redirect(failure ? `${base}?e=sync&code=${encodeURIComponent(failure)}` : `${base}?from=${from}&to=${to}&tt=synced`);
}

/** Save who receives this client's report and how often (owners/managers; enforced by RLS too). */
export async function saveReportSchedule(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const base = `/w/${ws}/c/${client}`;
  const access = await clientAccess(ws, client);
  if (!access.canManage) redirect(`${base}?e=forbidden`);

  const { valid, invalid } = normalizeRecipients(String(formData.get("recipients") ?? ""));
  const frequency = ["off", "weekly", "monthly"].includes(String(formData.get("frequency"))) ? String(formData.get("frequency")) : "off";
  const weekday = Math.min(7, Math.max(1, Number(formData.get("weekday")) || 7));
  const language = formData.get("language") === "en" ? "en" : "ar";
  if (invalid.length > 0 || valid.length > 20) redirect(`${base}?e=recipients#email`);

  const { error } = await access.supabase.from("report_schedules").upsert(
    {
      client_id: client, workspace_id: ws, frequency, send_weekday: weekday, language, recipients: valid,
      updated_by: access.user.id, updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id" },
  );
  if (error) {
    console.error(JSON.stringify({ event: "report_schedule_save_failed", client, code: error.code }));
    redirect(`${base}?e=email&code=${encodeURIComponent(error.code ?? "UNKNOWN")}#email`);
  }
  await access.supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: access.user.id, action: "report_schedule.updated",
    entity_type: "client", entity_id: client, metadata: { frequency, send_weekday: weekday, language, recipients: valid.length },
  });
  redirect(`${base}?mail=saved#email`);
}

/** Email the report for the chosen period to the saved recipients now (owners/managers). */
export async function sendReportNow(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const from = String(formData.get("from"));
  const to = String(formData.get("to"));
  const base = `/w/${ws}/c/${client}`;
  if (!ISO.test(from) || !ISO.test(to) || to < from) redirect(`${base}?e=period`);
  const access = await clientAccess(ws, client);
  if (!access.canManage) redirect(`${base}?e=forbidden`);

  let outcome = "";
  try {
    if (!env.emailConfigured()) throw Object.assign(new Error("Email not configured"), { code: "RESEND_NOT_CONFIGURED" });
    const { data: schedule } = await access.supabase
      .from("report_schedules").select("recipients, language").eq("client_id", client).maybeSingle();
    const recipients = (schedule?.recipients as string[] | undefined) ?? [];
    if (recipients.length === 0) throw Object.assign(new Error("No recipients"), { code: "NO_RECIPIENTS" });
    const result = await deliverReport(
      {
        db: serverDb(), mailer: new ResendMailer(env.resendApiKey()),
        model: env.anthropicConfigured() ? new ClaudeCommentaryModel() : null,
        from: env.reportsFrom(), replyTo: env.reportsReplyTo(), appUrl: env.appUrl(),
      },
      { clientId: client, period: { from, to }, recipients, language: schedule?.language === "en" ? "en" : "ar", trigger: "manual", sentBy: access.user.id },
    );
    outcome = `mail=sent&n=${result.sent.length}&f=${result.failed.length}`
      + (result.failed[0] ? `&code=${encodeURIComponent(result.failed[0].code)}` : "");
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "report_email_failed", client, code: d.code, error: d.message }));
    outcome = `e=email&code=${encodeURIComponent(d.code)}`;
  }
  // redirect() must be called outside try/catch.
  redirect(`${base}?from=${from}&to=${to}&${outcome}#email`);
}

