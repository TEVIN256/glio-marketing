"use server";

import { redirect } from "next/navigation";
import { DEMO_EXTERNAL_ID, TikTokConnector, demoTikTokFetch } from "@glio/connectors";
import { ClaudeCommentaryModel, createReportSnapshot } from "@glio/reports";
import { InMemorySecretStore, reconcile, runSync } from "@glio/sync";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { serverDb } from "@/lib/server-db";

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
