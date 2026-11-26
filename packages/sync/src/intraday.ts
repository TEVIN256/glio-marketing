import type { HourlyMetricRow, ReportingConnector, DailyMetricRow } from "@glio/connectors";
import { decimalToMinor } from "@glio/core";
import { type RetryOptions, defaultRetry, withRetry } from "./retry.ts";
import { type AdAccount, archivePayload } from "./run-sync.ts";
import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/**
 * Today so far (migration 0016, ADR-033): provisional per-campaign figures for one
 * day, as a day total (with purchase value) and per hour (without: TikTok has no
 * hourly purchase value). Fetched on demand, at most once per `minIntervalMinutes`
 * per account and day (concurrent viewers share one fetch). Every response is
 * archived like any other sync; the day's rows are replaced as a whole. Nothing
 * here touches metric_daily, reports or reconciliation.
 */

export const INTRADAY_MIN_INTERVAL_MINUTES = 10;

export interface IntradayDeps {
  db: SqlExecutor;
  connector: ReportingConnector;
  secrets: SecretStore;
  retry?: Partial<RetryOptions>;
}

export type IntradayResult =
  | { status: "fresh" } // fetched recently (or being fetched by someone else): nothing to do
  | { status: "refreshed"; rows: number }
  | { status: "failed"; errorCode: string };

export async function refreshIntraday(
  deps: IntradayDeps,
  args: { adAccountId: string; day: string; grains: Array<"day" | "hour">; minIntervalMinutes: number },
): Promise<IntradayResult> {
  const { db, connector, secrets } = deps;
  const retry: RetryOptions = { ...defaultRetry, ...deps.retry };

  // Claim this refresh (one per account+day per interval), or find one recent enough.
  const claim = await db.transaction(async (q) => {
    await q("select pg_advisory_xact_lock(hashtext($1))", [`intraday|${args.adAccountId}|${args.day}`]);
    const [recent] = await q(
      `select 1 from public.sync_runs where ad_account_id = $1 and kind = 'intraday' and date_from = $2
         and status <> 'failed' and started_at > now() - ($3 || ' minutes')::interval limit 1`,
      [args.adAccountId, args.day, String(args.minIntervalMinutes)],
    );
    if (recent) return null;
    const [account] = await q(
      `select id, workspace_id, client_id, platform, external_id, currency from public.ad_accounts
       where id = $1 and status = 'active'`,
      [args.adAccountId],
    );
    if (!account) return null;
    const [run] = await q(
      `insert into public.sync_runs (workspace_id, client_id, ad_account_id, platform, kind, date_from, date_to)
       values ($1, $2, $3, $4, 'intraday', $5, $5) returning id`,
      [account.workspace_id, account.client_id, account.id, account.platform, args.day],
    );
    return { account: account as AdAccount, runId: run!.id as string };
  });
  if (!claim) return { status: "fresh" };
  const { account, runId } = claim;

  let accessToken = "";
  let pages = 0;
  try {
    if (!account.currency) throw Object.assign(new Error("Ad account currency is unknown"), { code: "missing_currency" });
    const [cred] = await db.query("select secret_ref from public.ad_account_credentials where ad_account_id = $1", [account.id]);
    if (!cred) throw Object.assign(new Error("Ad account has no stored credentials"), { code: "not_connected" });
    accessToken = await secrets.get(cred.secret_ref);

    const collected: Array<{ grain: "day" | "hour"; row: DailyMetricRow & { hour?: number }; payloadId: number }> = [];
    for (const grain of args.grains) {
      let page = 1;
      let total = 1;
      do {
        const req = { accessToken, externalAccountId: account.external_id, page };
        const result = grain === "day"
          ? await withRetry(() => connector.fetchDailyReportPage({ ...req, dateFrom: args.day, dateTo: args.day }), retry)
          : await withRetry(() => {
              if (!connector.fetchHourlyReportPage) throw Object.assign(new Error("No hourly reports"), { code: "unsupported" });
              return connector.fetchHourlyReportPage({ ...req, day: args.day });
            }, retry);
        pages++;
        const payloadId = await archivePayload(db.query, account, runId, result);
        for (const row of result.rows as Array<DailyMetricRow | HourlyMetricRow>) {
          if (row.date !== args.day) throw Object.assign(new Error(`Platform returned ${row.date}, not ${args.day}`), { code: "bad_data" });
          collected.push({ grain, row, payloadId });
        }
        total = result.totalPages;
        page++;
      } while (page <= total);
    }

    const currency = account.currency;
    const minor = (v: string | null) => (v === null ? null : decimalToMinor(v, currency).toString());
    const rows = await db.transaction(async (q) => {
      await q("delete from public.metric_intraday where ad_account_id = $1 and day = $2 and grain = any($3::text[])",
        [account.id, args.day, args.grains]);
      for (const { grain, row, payloadId } of collected) {
        await q(
          `insert into public.metric_intraday
             (workspace_id, client_id, ad_account_id, platform, entity_id, entity_name, day, grain, hour, currency,
              spend_minor, impressions, clicks, conversions, purchase_value_minor, raw_payload_id, sync_run_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           on conflict (ad_account_id, entity_id, day, grain, hour) do nothing`,
          [account.workspace_id, account.client_id, account.id, account.platform, row.entityId, row.entityName, args.day,
            grain, grain === "hour" ? (row.hour ?? 0) : 0, currency, minor(row.spend), row.impressions, row.clicks,
            row.conversions, minor(row.purchaseValue), payloadId, runId],
        );
      }
      await q("update public.sync_runs set status = 'succeeded', pages_fetched = $2, rows_written = $3, finished_at = now() where id = $1",
        [runId, pages, collected.length]);
      return collected.length;
    });
    return { status: "refreshed", rows };
  } catch (err) {
    const raw = (err as { code?: unknown })?.code;
    const code = typeof raw === "string" && /^[A-Za-z0-9_]{1,40}$/.test(raw) ? raw : "internal_error";
    const message = (err instanceof Error ? err.message : String(err));
    await db.query(
      "update public.sync_runs set status = 'failed', pages_fetched = $2, error_code = $3, error_message = $4, finished_at = now() where id = $1",
      [runId, pages, code, accessToken ? message.split(accessToken).join("[redacted]") : message],
    );
    return { status: "failed", errorCode: code };
  }
}
