import { randomUUID } from "node:crypto";
import { tiktokApi } from "@glio/connectors";
import { type SqlExecutor, VaultSecretStore } from "@glio/sync";
import { env } from "./env";
import { describeError } from "./errors";

/**
 * SERVER ONLY. Live checks of what GLIO depends on (owners only, on the
 * Diagnostics page): configuration present (never values), the database
 * schema at the latest migration, a Vault write/read/delete round trip, TikTok
 * reachable, and recent failures recorded in the database.
 */

export type CheckStatus = "ok" | "bad" | "warn" | "info";
export interface Check { group: string; name: string; status: CheckStatus; detail: string }

/** The latest migration's objects and the expected policy count (keep in step with docs/RUNBOOK.md). */
export const EXPECTED_POLICIES = 49;
const EXPECTED_TABLES = [
  "workspaces", "clients", "ad_accounts", "ad_account_credentials", "sync_runs", "raw_platform_payloads", "metric_daily",
  "reconciliation_checks", "report_snapshots", "ai_commentary", "report_schedules", "report_deliveries", "approval_requests",
  "client_guardrails", "notification_settings", "invitations", "suggestion_settings", "report_shares", "report_unsubscribes", "pending_ad_connections",
];
const EXPECTED_FUNCTIONS = ["decide_approval", "accept_invitation", "invitation_preview", "purge_expired_data"];
/** Columns added to existing tables by later migrations (the code writes them; a missing one breaks syncs or emails). */
const EXPECTED_COLUMNS: Array<[string, string]> = [
  ["report_deliveries", "unsubscribe_token_hash"], // 0012
  ["metric_daily", "purchase_value_minor"], // 0014
];

export function configChecks(e: NodeJS.ProcessEnv = process.env): Check[] {
  const set = (k: string) => Boolean(e[k] && String(e[k]).trim());
  const rows: Check[] = [];
  const need = (k: string, why: string) =>
    rows.push({ group: "Configuration", name: k, status: set(k) ? "ok" : "bad", detail: set(k) ? "set" : `missing: ${why}` });
  need("DATABASE_URL", "nothing works");
  need("NEXT_PUBLIC_SUPABASE_URL", "sign-in");
  need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sign-in");
  need("TIKTOK_APP_ID", "Connect TikTok");
  need("TIKTOK_APP_SECRET", "Connect TikTok");
  need("RESEND_API_KEY", "report and notification emails");
  need("CRON_SECRET", "the daily job");
  if (set("TIKTOK_APP_ID")) {
    const id = String(e.TIKTOK_APP_ID).trim();
    rows.push({ group: "Configuration", name: "TIKTOK_APP_ID looks like an app id", status: /^\d{10,25}$/.test(id) ? "ok" : "bad",
      detail: /^\d{10,25}$/.test(id) ? `${id.length} digits` : "should be digits only (no spaces or quotes)" });
  }
  if (set("TIKTOK_APP_SECRET")) {
    const s = String(e.TIKTOK_APP_SECRET);
    const clean = s.trim() === s && !/\s/.test(s);
    rows.push({ group: "Configuration", name: "TIKTOK_APP_SECRET format", status: clean ? "ok" : "bad",
      detail: clean ? `${s.length} characters, no spaces` : "has spaces or line breaks: paste it again" });
  }
  const redirect = e.TIKTOK_REDIRECT_URI || "https://www.glioagency.org/integrations/tiktok/callback";
  rows.push({ group: "Configuration", name: "TikTok redirect URL", status: redirect === "https://www.glioagency.org/integrations/tiktok/callback" ? "ok" : "warn",
    detail: `${redirect} (must match the app in TikTok's portal exactly)` });
  rows.push({ group: "Configuration", name: "GLIO_DEMO_MODE", status: "info",
    detail: e.GLIO_DEMO_MODE === "1" ? "on: 'Load demo data' buttons visible (turn off once real clients use GLIO)" : "off" });
  rows.push({ group: "Configuration", name: "AI commentary (ANTHROPIC_API_KEY)", status: "info",
    detail: set("ANTHROPIC_API_KEY") ? "set: summaries written by AI" : "not set: automatic summaries from the figures" });
  return rows;
}

export async function databaseChecks(db: SqlExecutor): Promise<Check[]> {
  const rows: Check[] = [];
  try {
    const [who] = await db.query("select current_user as u, now() as t");
    rows.push({ group: "Database", name: "Server connection", status: "ok", detail: `connected as ${who!.u}` });
  } catch (err) {
    const d = describeError(err);
    return [{ group: "Database", name: "Server connection", status: "bad", detail: `${d.code}: ${d.message}` }];
  }

  const tables = (await db.query("select tablename from pg_tables where schemaname = 'public'")).map((r) => r.tablename as string);
  const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
  rows.push({ group: "Database", name: "Tables (migrations applied)", status: missing.length ? "bad" : "ok",
    detail: missing.length ? `missing: ${missing.join(", ")}` : `${EXPECTED_TABLES.length} expected tables present` });
  const fns = (await db.query("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'"))
    .map((r) => r.proname as string);
  const missingFns = EXPECTED_FUNCTIONS.filter((f) => !fns.includes(f));
  rows.push({ group: "Database", name: "Functions", status: missingFns.length ? "bad" : "ok",
    detail: missingFns.length ? `missing: ${missingFns.join(", ")}` : "present" });
  const cols = await db.query(
    "select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'");
  const have = new Set(cols.map((r) => r.c as string));
  const missingCols = EXPECTED_COLUMNS.map(([t, c]) => `${t}.${c}`).filter((c) => !have.has(c));
  rows.push({ group: "Database", name: "Columns from later migrations", status: missingCols.length ? "bad" : "ok",
    detail: missingCols.length ? `missing: ${missingCols.join(", ")} (run the migration SQL)` : "present" });
  const [pol] = await db.query("select count(*)::int as n from pg_policies where schemaname = 'public'");
  rows.push({ group: "Database", name: "Row-level security policies", status: pol!.n === EXPECTED_POLICIES ? "ok" : "warn",
    detail: `${pol!.n} (expected ${EXPECTED_POLICIES})` });
  const noRls = await db.query(
    "select tablename from pg_tables where schemaname = 'public' and not rowsecurity order by tablename");
  rows.push({ group: "Database", name: "Every table has row-level security on", status: noRls.length ? "bad" : "ok",
    detail: noRls.length ? `off on: ${noRls.map((r) => r.tablename).join(", ")}` : "yes" });

  // Vault round trip: exactly what connecting TikTok does with the token.
  const ref = `vault:glio/selftest/${randomUUID()}`;
  const store = new VaultSecretStore(db);
  try {
    await store.put(ref, "selftest-not-a-real-token");
    const back = await store.get(ref);
    await store.delete(ref);
    rows.push({ group: "Database", name: "Vault (token storage) write → read → delete", status: back === "selftest-not-a-real-token" ? "ok" : "bad",
      detail: back === "selftest-not-a-real-token" ? "works" : "read back a different value" });
  } catch (err) {
    const d = describeError(err);
    await store.delete(ref).catch(() => {});
    rows.push({ group: "Database", name: "Vault (token storage) write → read → delete", status: "bad", detail: `${d.code}: ${d.message}` });
  }

  // Recent failures recorded in the database (last 7 days).
  const recent = async (name: string, sql: string) => {
    const r = await db.query(sql);
    const n = r.length;
    rows.push({ group: "Recent failures (7 days)", name, status: n ? "warn" : "ok",
      detail: n ? r.map((x) => `${String(x.at).slice(0, 16).replace("T", " ")} ${x.code ?? ""}`.trim()).slice(0, 5).join(" · ") : "none" });
  };
  await recent("Data syncs", `select started_at as at, error_code as code from public.sync_runs
    where status = 'failed' and started_at > now() - interval '7 days' order by started_at desc limit 20`);
  await recent("Report emails", `select created_at as at, error_code as code from public.report_deliveries
    where status = 'failed' and created_at > now() - interval '7 days' order by created_at desc limit 20`);
  await recent("Approved changes", `select coalesce(executed_at, decided_at) as at, error_code as code from public.approval_requests
    where status = 'failed' and coalesce(executed_at, decided_at, created_at) > now() - interval '7 days' order by 1 desc limit 20`);
  const [stuck] = await db.query("select count(*)::int as n from public.sync_runs where status = 'running' and started_at < now() - interval '15 minutes'");
  rows.push({ group: "Recent failures (7 days)", name: "Syncs stuck in 'running'", status: stuck!.n ? "warn" : "ok", detail: String(stuck!.n) });
  return rows;
}

/** TikTok's API answers (a call without a token must come back as a TikTok error, not a network failure). */
export async function tiktokReachable(fetchImpl: typeof fetch = fetch): Promise<Check> {
  try {
    const res = await fetchImpl(`${tiktokApi.TIKTOK_API_BASE}/advertiser/info/`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    const ok = typeof body?.code === "number";
    return { group: "TikTok", name: "TikTok API reachable", status: ok ? "ok" : "warn",
      detail: ok ? `HTTP ${res.status}, answered with code ${body!.code} (expected without a token)` : `HTTP ${res.status}, unexpected answer` };
  } catch (err) {
    return { group: "TikTok", name: "TikTok API reachable", status: "bad", detail: describeError(err).code };
  }
}

export async function runSystemChecks(db: SqlExecutor): Promise<Check[]> {
  const [dbRows, tt] = await Promise.all([databaseChecks(db), tiktokReachable()]);
  return [...configChecks(), ...dbRows, tt, {
    group: "Configuration", name: "App URL used in emails and links", status: "info", detail: env.appUrl(),
  }];
}
