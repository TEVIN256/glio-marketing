import { MoneyError, decimalToMinor, splitWindows } from "@glio/core";
import { type AccountTotals, PlatformError, type ReportingConnector } from "@glio/connectors";
import { randomUUID } from "node:crypto";
import { type RetryOptions, defaultRetry, withRetry } from "./retry.ts";
import { archivePayload, loadAccount } from "./run-sync.ts";
import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/** 0.5% in parts per million. */
export const DEFAULT_THRESHOLD_PPM = 5_000;

export type MetricName = "spend" | "impressions" | "clicks" | "conversions";
export type CheckStatus = "ok" | "drift" | "not_comparable";

/** Conversions can be fractional; compare them as integers scaled by 10^4 (numeric(20,4)). */
const CONVERSION_SCALE = 4;

export interface MetricComparison {
  metric: MetricName;
  ours: bigint | null;
  theirs: bigint | null;
  driftPpm: bigint | null;
  status: CheckStatus;
  note: string | null;
}

/**
 * Compare one metric. Exact integer arithmetic: drift is
 * |ours - theirs| / theirs, flagged when strictly greater than the threshold.
 */
export function compareMetric(
  metric: MetricName,
  ours: bigint | null,
  theirs: bigint | null,
  thresholdPpm: number,
): MetricComparison {
  const base = { metric, ours, theirs };
  if (theirs === null) return { ...base, driftPpm: null, status: "not_comparable", note: "Not provided by platform" };
  if (ours === null) return { ...base, driftPpm: null, status: "not_comparable", note: "Glio has no stored value for this metric" };

  const diff = ours > theirs ? ours - theirs : theirs - ours;
  if (theirs === 0n) {
    return diff === 0n
      ? { ...base, driftPpm: 0n, status: "ok", note: null }
      : { ...base, driftPpm: 1_000_000n, status: "drift", note: "Platform reports 0 but Glio stored a value" };
  }
  const threshold = BigInt(thresholdPpm);
  const driftPpm = (diff * 1_000_000n) / theirs; // floored, for display
  const flagged = diff * 1_000_000n > threshold * theirs; // exact, for the decision
  return { ...base, driftPpm, status: flagged ? "drift" : "ok", note: null };
}

export interface ReconcileDeps {
  db: SqlExecutor;
  connector: ReportingConnector;
  secrets: SecretStore;
  retry?: Partial<RetryOptions>;
  /** Structured log sink. Defaults to one JSON line on stdout. Never receives credentials. */
  log?: (event: Record<string, unknown>) => void;
}

export interface ReconcileArgs {
  /** Reconcile the account and date range of this (succeeded) sync run. */
  syncRunId: string;
  thresholdPpm?: number;
}

export interface ReconcileResult {
  checkId: string | null;
  status: CheckStatus | "failed";
  results: MetricComparison[];
  errorCode?: string;
}

const defaultLog = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

/**
 * Compare Glio's stored totals with the platform's own account totals for the
 * sync run's date range, store one check row per metric, and log the outcome.
 * Overall status: drift if any metric drifted, otherwise not_comparable if any
 * metric couldn't be compared, otherwise ok.
 */
export async function reconcile(deps: ReconcileDeps, args: ReconcileArgs): Promise<ReconcileResult> {
  const { db, connector, secrets } = deps;
  const log = deps.log ?? defaultLog;
  const retry: RetryOptions = { ...defaultRetry, ...deps.retry };
  const thresholdPpm = args.thresholdPpm ?? DEFAULT_THRESHOLD_PPM;

  const [run] = await db.query(
    "select id, ad_account_id, date_from::text as date_from, date_to::text as date_to, status from public.sync_runs where id = $1",
    [args.syncRunId],
  );
  if (!run) throw new Error(`Sync run ${args.syncRunId} not found`);
  if (run.status !== "succeeded") throw new Error(`Sync run ${args.syncRunId} did not succeed; nothing to reconcile`);
  const account = await loadAccount(db.query, run.ad_account_id);
  const window = { dateFrom: run.date_from as string, dateTo: run.date_to as string };
  const logBase = { event: "reconciliation", platform: account.platform, adAccountId: account.id, syncRunId: run.id, ...window };

  let accessToken = "";
  try {
    if (!account.currency) throw new PlatformError("Ad account currency is unknown", connector.platform, "missing_currency", false);
    const [cred] = await db.query("select secret_ref from public.ad_account_credentials where ad_account_id = $1", [account.id]);
    if (!cred) throw new PlatformError("Ad account has no stored credentials", connector.platform, "not_connected", false);
    accessToken = await secrets.get(cred.secret_ref);

    // 1. The platform's totals, per window (a range longer than the platform allows is split and summed).
    const answers: AccountTotals[] = [];
    const payloadIds: number[] = [];
    for (const w of splitWindows(window.dateFrom, window.dateTo, connector.maxDaysPerRequest)) {
      const totals = await withRetry(
        () => connector.fetchAccountTotals({ accessToken, externalAccountId: account.external_id, dateFrom: w.from, dateTo: w.to }),
        retry,
      );
      answers.push(totals);
      payloadIds.push(await archivePayload(db.query, account, run.id, totals));
    }
    const theirs = sumPlatformTotals(answers, account.currency);

    // 2. Our totals from the stored daily rows.
    const [o] = await db.query(
      `select count(*)::int as n,
              count(spend_minor)::int as n_spend, sum(spend_minor)::text as spend,
              count(impressions)::int as n_impr, sum(impressions)::text as impressions,
              count(clicks)::int as n_clicks, sum(clicks)::text as clicks,
              count(conversions)::int as n_conv, sum(conversions)::text as conversions
       from public.metric_daily
       where ad_account_id = $1 and level = 'campaign' and date between $2 and $3`,
      [account.id, window.dateFrom, window.dateTo],
    );
    const ours = (value: string | null, nonNull: number): bigint | null | "mixed" => {
      if (nonNull === 0) return o!.n === 0 ? 0n : null; // no rows at all = nothing delivered
      if (nonNull < o!.n) return "mixed";
      return value === null ? 0n : BigInt(value);
    };
    const oursConv = o!.n_conv === 0 ? (o!.n === 0 ? 0n : null) : o!.n_conv < o!.n ? "mixed" : scaled(o!.conversions ?? "0");

    // 3. Compare.
    const compare = (metric: MetricName, ourValue: bigint | null | "mixed", theirValue: bigint | null) => {
      if (ourValue === "mixed") {
        return { metric, ours: null, theirs: theirValue, driftPpm: null, status: "not_comparable" as const, note: "Some stored daily rows lack this metric" };
      }
      if (theirs.allEmpty) {
        return (ourValue ?? 0n) === 0n
          ? { metric, ours: ourValue, theirs: null, driftPpm: 0n, status: "ok" as const, note: "Platform reported no activity; Glio stored none" }
          : { metric, ours: ourValue, theirs: null, driftPpm: 1_000_000n, status: "drift" as const, note: "Platform reported no activity but Glio stored some" };
      }
      const result = compareMetric(metric, ourValue, theirValue, thresholdPpm);
      if (theirs.emptyWindows > 0 && result.note === null) {
        result.note = `${theirs.emptyWindows} of ${answers.length} platform windows returned no rows`;
      }
      return result;
    };
    const results: MetricComparison[] = [
      compare("spend", ours(o!.spend, o!.n_spend), theirs.spend),
      compare("impressions", ours(o!.impressions, o!.n_impr), theirs.impressions),
      compare("clicks", ours(o!.clicks, o!.n_clicks), theirs.clicks),
      compare("conversions", oursConv, theirs.conversions),
    ];
    const status: CheckStatus = results.some((r) => r.status === "drift")
      ? "drift"
      : results.some((r) => r.status === "not_comparable") ? "not_comparable" : "ok";

    // 4. Store the check (one row per metric) as a single unit.
    const checkId = randomUUID();
    const evidenceNote = payloadIds.length > 1 ? `Platform totals span ${payloadIds.length} responses: ${payloadIds.join(", ")}` : null;
    await db.transaction(async (q) => {
      for (const r of results) {
        await q(
          `insert into public.reconciliation_checks
             (check_id, workspace_id, client_id, ad_account_id, platform, sync_run_id, date_from, date_to, metric, unit, currency,
              ours, theirs, drift_ppm, threshold_ppm, status, note, platform_payload_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            checkId, account.workspace_id, account.client_id, account.id, account.platform, run.id, window.dateFrom, window.dateTo,
            r.metric, unitOf(r.metric), r.metric === "spend" ? account.currency : null,
            display(r.metric, r.ours), display(r.metric, r.theirs), r.driftPpm?.toString() ?? null, thresholdPpm,
            r.status, [r.note, evidenceNote].filter(Boolean).join(" | ") || null, payloadIds[0],
          ],
        );
      }
    });

    log({
      ...logBase,
      level: status === "drift" ? "warn" : "info",
      checkId,
      status,
      thresholdPpm,
      drifted: results.filter((r) => r.status === "drift").map((r) => ({
        metric: r.metric, ours: display(r.metric, r.ours), theirs: display(r.metric, r.theirs), driftPpm: r.driftPpm?.toString(),
      })),
    });
    return { checkId, status, results };
  } catch (err) {
    const code = err instanceof PlatformError ? err.code : err instanceof MoneyError ? "bad_data" : "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    log({ ...logBase, level: "error", status: "failed", errorCode: code, error: accessToken ? message.split(accessToken).join("[redacted]") : message });
    return { checkId: null, status: "failed", results: [], errorCode: code };
  }
}

function sumPlatformTotals(answers: AccountTotals[], currency: string) {
  const nonEmpty = answers.filter((a) => !a.empty);
  const sum = (pick: (a: AccountTotals) => bigint | null): bigint | null => {
    if (nonEmpty.length === 0) return null;
    let total = 0n;
    for (const a of nonEmpty) {
      const v = pick(a);
      if (v === null) return null; // any window "not provided" makes the total not provided
      total += v;
    }
    return total;
  };
  return {
    allEmpty: nonEmpty.length === 0,
    emptyWindows: answers.length - nonEmpty.length,
    spend: sum((a) => (a.spend === null ? null : decimalToMinor(a.spend, currency))),
    impressions: sum((a) => (a.impressions === null ? null : BigInt(a.impressions))),
    clicks: sum((a) => (a.clicks === null ? null : BigInt(a.clicks))),
    conversions: sum((a) => (a.conversions === null ? null : scaled(a.conversions))),
  };
}

/** "29" -> 290000n, "1.5" -> 15000n (scale 4). Refuses more precision than storage keeps. */
function scaled(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) throw new MoneyError(`Not a non-negative decimal: "${decimal}"`);
  const fraction = m[2] ?? "";
  if (fraction.length > CONVERSION_SCALE && /[1-9]/.test(fraction.slice(CONVERSION_SCALE))) {
    throw new MoneyError(`"${decimal}" has more than ${CONVERSION_SCALE} decimals; refusing to round`);
  }
  return BigInt((m[1] ?? "0") + fraction.slice(0, CONVERSION_SCALE).padEnd(CONVERSION_SCALE, "0"));
}

function unitOf(metric: MetricName): string {
  return metric === "spend" ? "minor_units" : metric === "conversions" ? "decimal" : "count";
}

/** Value as stored in the numeric column: minor units / counts as-is, conversions unscaled. */
function display(metric: MetricName, v: bigint | null): string | null {
  if (v === null) return null;
  if (metric !== "conversions") return v.toString();
  const s = v.toString().padStart(CONVERSION_SCALE + 1, "0");
  return `${s.slice(0, -CONVERSION_SCALE)}.${s.slice(-CONVERSION_SCALE)}`;
}
