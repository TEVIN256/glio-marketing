import { MoneyError, decimalToMinor, sha256OfJson, splitWindows } from "@glio/core";
import { type DailyMetricRow, PlatformError, type ReportingConnector, type ReportPage } from "@glio/connectors";
import { type RetryOptions, defaultRetry, withRetry } from "./retry.ts";
import type { SecretStore } from "./secrets.ts";
import type { Query, SqlExecutor } from "./sql.ts";

export type SyncKind = "scheduled" | "backfill" | "manual";

export interface SyncDeps {
  db: SqlExecutor;
  connector: ReportingConnector;
  secrets: SecretStore;
  retry?: Partial<RetryOptions>;
}

export interface SyncArgs {
  adAccountId: string;
  dateFrom: string;
  dateTo: string;
  kind: SyncKind;
}

export interface SyncResult {
  syncRunId: string;
  status: "succeeded" | "failed";
  pagesFetched: number;
  rowsWritten: number;
  errorCode?: string;
}

export interface AdAccount {
  id: string;
  workspace_id: string;
  client_id: string;
  platform: string;
  external_id: string;
  currency: string | null;
}

/**
 * Pull a platform's daily report for one ad account and date range.
 *
 *  1. A sync_run row is recorded first, so failures are visible.
 *  2. Every page is fetched (with retries for transient errors) and its raw
 *     response archived immediately with a SHA-256; identical responses are
 *     stored once per account.
 *  3. Only when every page succeeded are metrics written, in ONE transaction,
 *     upserted on (ad_account_id, level, entity_id, date). Rows whose values
 *     didn't change are left untouched, so re-running the same window writes
 *     nothing and creates no duplicates.
 *  4. Any failure marks the run failed and writes no metrics at all.
 */
export async function runSync(deps: SyncDeps, args: SyncArgs): Promise<SyncResult> {
  const { db, connector, secrets } = deps;
  const retry: RetryOptions = { ...defaultRetry, ...deps.retry };

  const account = await loadAccount(db.query, args.adAccountId);
  if (account.platform !== connector.platform) {
    throw new Error(`Ad account ${account.id} is ${account.platform}, connector is ${connector.platform}`);
  }

  const [run] = await db.query(
    `insert into public.sync_runs (workspace_id, client_id, ad_account_id, platform, kind, date_from, date_to)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [account.workspace_id, account.client_id, account.id, account.platform, args.kind, args.dateFrom, args.dateTo],
  );
  const syncRunId: string = run!.id;
  let pagesFetched = 0;
  let accessToken = "";

  try {
    if (!account.currency) throw new SyncError("missing_currency", "Ad account currency is unknown; refusing to store money without it");

    const [cred] = await db.query("select secret_ref from public.ad_account_credentials where ad_account_id = $1", [account.id]);
    if (!cred) throw new SyncError("not_connected", "Ad account has no stored credentials");
    accessToken = await secrets.get(cred.secret_ref);

    // Fetch and archive every page of every window.
    const collected: Array<{ row: DailyMetricRow; rawPayloadId: number }> = [];
    for (const window of splitWindows(args.dateFrom, args.dateTo, connector.maxDaysPerRequest)) {
      let page = 1;
      let totalPages = 1;
      do {
        const result: ReportPage = await withRetry(
          () => connector.fetchDailyReportPage({
            accessToken, externalAccountId: account.external_id, dateFrom: window.from, dateTo: window.to, page,
          }),
          retry,
        );
        pagesFetched++;
        const rawPayloadId = await archivePayload(db.query, account, syncRunId, result);
        for (const row of result.rows) collected.push({ row, rawPayloadId });
        totalPages = result.totalPages;
        page++;
      } while (page <= totalPages);
    }

    const prepared = prepareRows(collected, account.currency, args.dateFrom, args.dateTo);

    const rowsWritten = await db.transaction(async (q) => {
      let written = 0;
      for (const r of prepared) {
        const rows = await q(
          `insert into public.metric_daily
             (workspace_id, client_id, ad_account_id, platform, level, entity_id, entity_name, date, currency,
              spend_minor, impressions, clicks, conversions, purchase_value_minor, raw_payload_id, sync_run_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $16, $14, $15)
           on conflict (ad_account_id, level, entity_id, date) do update set
             entity_name = excluded.entity_name, currency = excluded.currency,
             spend_minor = excluded.spend_minor, impressions = excluded.impressions,
             clicks = excluded.clicks, conversions = excluded.conversions, purchase_value_minor = excluded.purchase_value_minor,
             raw_payload_id = excluded.raw_payload_id, sync_run_id = excluded.sync_run_id, updated_at = now()
           where (metric_daily.entity_name, metric_daily.currency, metric_daily.spend_minor, metric_daily.impressions,
                  metric_daily.clicks, metric_daily.conversions, metric_daily.purchase_value_minor, metric_daily.raw_payload_id)
                 is distinct from
                 (excluded.entity_name, excluded.currency, excluded.spend_minor, excluded.impressions,
                  excluded.clicks, excluded.conversions, excluded.purchase_value_minor, excluded.raw_payload_id)
           returning 1`,
          [
            account.workspace_id, account.client_id, account.id, account.platform, r.level, r.entityId, r.entityName,
            r.date, account.currency, r.spendMinor, r.impressions, r.clicks, r.conversions, r.rawPayloadId, syncRunId,
            r.purchaseValueMinor,
          ],
        );
        written += rows.length;
      }
      await q(
        `update public.sync_runs set status = 'succeeded', pages_fetched = $2, rows_written = $3, finished_at = now()
         where id = $1`,
        [syncRunId, pagesFetched, written],
      );
      return written;
    });

    return { syncRunId, status: "succeeded", pagesFetched, rowsWritten };
  } catch (err) {
    const code =
      err instanceof PlatformError || err instanceof SyncError ? err.code
      : err instanceof MoneyError ? "bad_data"
      : "internal_error";
    const message = redact(err instanceof Error ? err.message : String(err), accessToken);
    await db.query(
      `update public.sync_runs set status = 'failed', pages_fetched = $2, error_code = $3, error_message = $4,
              finished_at = now() where id = $1`,
      [syncRunId, pagesFetched, code, message],
    );
    return { syncRunId, status: "failed", pagesFetched, rowsWritten: 0, errorCode: code };
  }
}

export class SyncError extends Error {
  override name = "SyncError";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function loadAccount(query: Query, adAccountId: string): Promise<AdAccount> {
  const [row] = await query(
    "select id, workspace_id, client_id, platform, external_id, currency from public.ad_accounts where id = $1",
    [adAccountId],
  );
  if (!row) throw new Error(`Ad account ${adAccountId} not found`);
  return row as AdAccount;
}

/** Store the response unchanged; identical content is stored once per account. */
export async function archivePayload(
  query: Query,
  account: AdAccount,
  syncRunId: string,
  page: Pick<ReportPage, "endpoint" | "requestParams" | "payload" | "hashBasis">,
): Promise<number> {
  const hash = sha256OfJson(page.hashBasis);
  const inserted = await query(
    `insert into public.raw_platform_payloads
       (workspace_id, client_id, ad_account_id, platform, endpoint, request_params, payload, payload_sha256, first_sync_run_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (ad_account_id, endpoint, payload_sha256) do nothing
     returning id`,
    [account.workspace_id, account.client_id, account.id, account.platform, page.endpoint,
      JSON.stringify(page.requestParams), JSON.stringify(page.payload), hash, syncRunId],
  );
  if (inserted[0]) return Number(inserted[0].id);
  const [existing] = await query(
    "select id from public.raw_platform_payloads where ad_account_id = $1 and endpoint = $2 and payload_sha256 = $3",
    [account.id, page.endpoint, hash],
  );
  return Number(existing!.id);
}

interface PreparedRow {
  level: string;
  entityId: string;
  entityName: string | null;
  date: string;
  spendMinor: string | null; // bigint as string for pg
  impressions: number | null;
  clicks: number | null;
  conversions: string | null;
  purchaseValueMinor: string | null;
  rawPayloadId: number;
}

/**
 * Convert to minor units (exact) and check the data makes sense before any
 * write: every date inside the requested window, and no entity/day reported
 * twice with different numbers.
 */
function prepareRows(
  collected: Array<{ row: DailyMetricRow; rawPayloadId: number }>,
  currency: string,
  dateFrom: string,
  dateTo: string,
): PreparedRow[] {
  const byKey = new Map<string, PreparedRow>();
  for (const { row, rawPayloadId } of collected) {
    if (row.date < dateFrom || row.date > dateTo) {
      throw new SyncError("bad_data", `Platform returned ${row.date}, outside the requested ${dateFrom}..${dateTo}`);
    }
    const prepared: PreparedRow = {
      level: row.level,
      entityId: row.entityId,
      entityName: row.entityName,
      date: row.date,
      spendMinor: row.spend === null ? null : decimalToMinor(row.spend, currency).toString(),
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      purchaseValueMinor: row.purchaseValue === null ? null : decimalToMinor(row.purchaseValue, currency).toString(),
      rawPayloadId,
    };
    const key = `${row.level}|${row.entityId}|${row.date}`;
    const seen = byKey.get(key);
    if (seen) {
      const same = JSON.stringify({ ...seen, rawPayloadId: 0 }) === JSON.stringify({ ...prepared, rawPayloadId: 0 });
      if (!same) throw new SyncError("bad_data", `Platform reported ${key} twice with different numbers`);
      continue;
    }
    byKey.set(key, prepared);
  }
  return [...byKey.values()];
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}
