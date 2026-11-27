import {
  type AccountTotals, type AccountTotalsRequest, type DailyMetricRow, type DailyReportRequest, type FetchLike,
  type HourlyMetricRow, type HourlyReportPage, type HourlyReportRequest, PlatformError, type ReportingConnector, type ReportPage,
} from "../types.ts";
import {
  TIKTOK_ADVERTISER_GET_PATH, TIKTOK_ADVERTISER_INFO_FIELDS, TIKTOK_ADVERTISER_INFO_MAX_IDS, TIKTOK_ADVERTISER_INFO_PATH,
  TIKTOK_API_BASE, TIKTOK_AUTH_URL, TIKTOK_APP_VALUE_METRIC, TIKTOK_MAX_DAYS_PER_REPORT, TIKTOK_PURCHASE_VALUE_METRIC, TIKTOK_SHOP_REVENUE_METRIC, TIKTOK_REPORT_PATH, TIKTOK_RETRYABLE_CODES, TIKTOK_REVOKE_PATH, TIKTOK_TOKEN_PATH,
  accountTotalsParams, isNoValue, campaignDailyReportParams, campaignHourlyReportParams, type TikTokAdvertiserInfoData, type TikTokAdvertiserListData,
  type TikTokEnvelope, type TikTokReportData, type TikTokTokenData,
} from "./api.ts";

/** An ad account the advertiser authorised, as Glio stores it. */
export interface TikTokAdvertiser {
  externalId: string;
  name: string | null;
  currency: string | null; // ISO 4217, or null if TikTok didn't give a valid one
  timezone: string | null; // IANA name when available
}

export interface TikTokConnectorOptions {
  fetch?: FetchLike;
  apiBase?: string;
}

/**
 * Read-only TikTok connector (Stage 1). Write actions (launch, pause, budget)
 * will live behind the approval executor, not here.
 *
 * Credentials: the access token is sent only in the request header and is
 * never included in errors, logs, or stored request parameters.
 */
export class TikTokConnector implements ReportingConnector {
  readonly platform = "tiktok" as const;
  readonly maxDaysPerRequest = TIKTOK_MAX_DAYS_PER_REPORT;
  private readonly fetch: FetchLike;
  private readonly apiBase: string;

  constructor(opts: TikTokConnectorOptions = {}) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.apiBase = opts.apiBase ?? TIKTOK_API_BASE;
  }

  /** URL to send the business owner to, to approve Glio on TikTok. */
  static authorizationUrl(args: { appId: string; redirectUri: string; state: string }): string {
    const url = new URL(TIKTOK_AUTH_URL);
    url.searchParams.set("app_id", args.appId);
    url.searchParams.set("redirect_uri", args.redirectUri);
    url.searchParams.set("state", args.state);
    return url.toString();
  }

  /** Exchange the code TikTok returns on the redirect for an access token. */
  async exchangeAuthCode(args: { appId: string; appSecret: string; authCode: string }): Promise<{
    accessToken: string;
    advertiserIds: string[];
  }> {
    const res = await this.fetch(this.apiBase + TIKTOK_TOKEN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: args.appId, secret: args.appSecret, auth_code: args.authCode }),
    });
    const body = await this.readEnvelope<TikTokTokenData>(res, TIKTOK_TOKEN_PATH, [args.appSecret, args.authCode]);
    if (!body.data?.access_token) {
      throw new PlatformError("TikTok token response had no access token", "tiktok", "missing_token", false);
    }
    return { accessToken: body.data.access_token, advertiserIds: body.data.advertiser_ids ?? [] };
  }

  /**
   * The advertisers this token may use, with name, currency and timezone.
   * The app secret goes only to TikTok and is redacted from any error text.
   */
  /**
   * Revoke a long-term token at TikTok: it stops working for EVERY ad account it covers.
   * Returns the advertiser ids TikTok says the token can no longer access.
   */
  async revokeToken(args: { appId: string; appSecret: string; accessToken: string }): Promise<string[]> {
    const res = await this.fetch(this.apiBase + TIKTOK_REVOKE_PATH, {
      method: "POST",
      headers: { "Access-Token": args.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: args.appId, secret: args.appSecret, access_token: args.accessToken }),
    });
    const body = await this.readEnvelope<{ advertiser_ids?: unknown[] }>(res, TIKTOK_REVOKE_PATH, [args.appSecret, args.accessToken]);
    return (body.data?.advertiser_ids ?? []).map(String);
  }

  async listAdvertisers(args: { appId: string; appSecret: string; accessToken: string }): Promise<TikTokAdvertiser[]> {
    const secrets = [args.appSecret, args.accessToken];
    const listed = await this.get<TikTokAdvertiserListData>(
      TIKTOK_ADVERTISER_GET_PATH, { app_id: args.appId, secret: args.appSecret }, args.accessToken, secrets,
    );
    if (!Array.isArray(listed.list)) {
      throw new PlatformError("TikTok advertiser list is missing data.list", "tiktok", "bad_shape", false);
    }
    const byId = new Map<string, TikTokAdvertiser>();
    for (const a of listed.list) {
      const id = advertiserId(a.advertiser_id);
      if (!id) continue;
      byId.set(id, { externalId: id, name: textOrNull(a.advertiser_name), currency: null, timezone: null });
    }
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += TIKTOK_ADVERTISER_INFO_MAX_IDS) {
      const chunk = ids.slice(i, i + TIKTOK_ADVERTISER_INFO_MAX_IDS);
      const info = await this.get<TikTokAdvertiserInfoData>(
        TIKTOK_ADVERTISER_INFO_PATH, { advertiser_ids: chunk, fields: TIKTOK_ADVERTISER_INFO_FIELDS }, args.accessToken, secrets,
      );
      for (const row of info.list ?? []) {
        const known = byId.get(advertiserId(row.advertiser_id));
        if (!known) continue;
        known.name = textOrNull(row.name) ?? known.name;
        known.currency = currencyOrNull(row.currency);
        known.timezone = timezoneOrNull(row.display_timezone) ?? timezoneOrNull(row.timezone);
      }
    }
    return [...byId.values()];
  }

  async fetchDailyReportPage(req: DailyReportRequest): Promise<ReportPage> {
    const params = campaignDailyReportParams(req.externalAccountId, req.dateFrom, req.dateTo, req.page, req.valueSources);
    const { body, data } = await this.getReport(params, req.accessToken);

    return {
      endpoint: TIKTOK_REPORT_PATH,
      requestParams: params,
      payload: body,
      hashBasis: withoutRequestId(body),
      page: data.page_info.page,
      totalPages: data.page_info.total_page,
      rows: data.list.map(toRow),
    };
  }

  async fetchHourlyReportPage(req: HourlyReportRequest): Promise<HourlyReportPage> {
    const params = campaignHourlyReportParams(req.externalAccountId, req.day, req.page);
    const { body, data } = await this.getReport(params, req.accessToken);
    return {
      endpoint: TIKTOK_REPORT_PATH,
      requestParams: params,
      payload: body,
      hashBasis: withoutRequestId(body),
      page: data.page_info.page,
      totalPages: data.page_info.total_page,
      rows: data.list.map(toHourlyRow),
    };
  }

  async fetchAccountTotals(req: AccountTotalsRequest): Promise<AccountTotals> {
    const params = accountTotalsParams(req.externalAccountId, req.dateFrom, req.dateTo, req.valueSources);
    const { body, data } = await this.getReport(params, req.accessToken);
    if (data.list.length > 1) {
      throw new PlatformError(`TikTok account totals returned ${data.list.length} rows, expected 1`, "tiktok", "bad_shape", false);
    }
    // An inactive range comes back as one row of zeros (seen on a real account, 2026-11-26).
    // No row at all is still handled: we don't assume it means zero; reconciliation decides.
    const m = data.list[0]?.metrics ?? {};
    return {
      endpoint: TIKTOK_REPORT_PATH,
      requestParams: params,
      payload: body,
      hashBasis: withoutRequestId(body),
      empty: data.list.length === 0,
      spend: decimalOrNull(m["spend"]),
      impressions: integerOrNull(m["impressions"]),
      clicks: integerOrNull(m["clicks"]),
      conversions: decimalOrNull(m["conversion"]),
      purchaseValue: decimalOrNull(m[TIKTOK_PURCHASE_VALUE_METRIC]),
      appPurchaseValue: decimalOrNull(m[TIKTOK_APP_VALUE_METRIC]),
      shopRevenue: decimalOrNull(m[TIKTOK_SHOP_REVENUE_METRIC]),
    };
  }

  private async getReport(params: Record<string, unknown>, accessToken: string) {
    const url = new URL(this.apiBase + TIKTOK_REPORT_PATH);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const res = await this.fetch(url.toString(), { method: "GET", headers: { "Access-Token": accessToken } });
    const body = await this.readEnvelope<TikTokReportData>(res, TIKTOK_REPORT_PATH, [accessToken]);
    const data = body.data;
    if (!data || !Array.isArray(data.list) || !data.page_info) {
      throw new PlatformError("TikTok report response is missing data.list or data.page_info", "tiktok", "bad_shape", false);
    }
    return { body, data };
  }

  /** GET a TikTok endpoint; array parameters are JSON-encoded. Returns `data`. */
  private async get<T>(path: string, params: Record<string, unknown>, accessToken: string, secrets: string[]): Promise<T> {
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const res = await this.fetch(url.toString(), { method: "GET", headers: { "Access-Token": accessToken } });
    const body = await this.readEnvelope<T>(res, path, secrets);
    if (!body.data) throw new PlatformError(`TikTok ${path} response has no data`, "tiktok", "bad_shape", false);
    return body.data;
  }

  private async readEnvelope<T>(
    res: { status: number; json(): Promise<unknown> },
    path: string,
    secrets: string[],
  ): Promise<TikTokEnvelope<T>> {
    if (res.status === 429 || res.status >= 500) {
      throw new PlatformError(`TikTok ${path} returned HTTP ${res.status}`, "tiktok", `http_${res.status}`, true);
    }
    if (res.status !== 200) {
      throw new PlatformError(`TikTok ${path} returned HTTP ${res.status}`, "tiktok", `http_${res.status}`, false);
    }
    const body = (await res.json()) as TikTokEnvelope<T>;
    if (typeof body?.code !== "number") {
      throw new PlatformError(`TikTok ${path} returned an unexpected body`, "tiktok", "bad_shape", false);
    }
    if (body.code !== 0) {
      throw new PlatformError(
        `TikTok ${path} error ${body.code}: ${sanitize(body.message, secrets)}`, "tiktok", `tiktok_${body.code}`,
        TIKTOK_RETRYABLE_CODES.has(body.code),
      );
    }
    return body;
  }
}

function toRow(item: TikTokReportData["list"][number]): DailyMetricRow {
  const d = item.dimensions ?? {};
  const m = item.metrics ?? {};
  const campaignId = d["campaign_id"];
  const day = d["stat_time_day"];
  if (!campaignId || !day) {
    throw new PlatformError("TikTok report row is missing campaign_id or stat_time_day", "tiktok", "bad_shape", false);
  }
  return {
    level: "campaign",
    entityId: String(campaignId),
    entityName: m["campaign_name"] == null ? null : String(m["campaign_name"]),
    date: String(day).slice(0, 10), // "2026-01-05 00:00:00" -> "2026-01-05"
    spend: decimalOrNull(m["spend"]),
    impressions: integerOrNull(m["impressions"]),
    clicks: integerOrNull(m["clicks"]),
    conversions: decimalOrNull(m["conversion"]),
    purchaseValue: decimalOrNull(m[TIKTOK_PURCHASE_VALUE_METRIC]),
    appPurchaseValue: decimalOrNull(m[TIKTOK_APP_VALUE_METRIC]),
    shopRevenue: decimalOrNull(m[TIKTOK_SHOP_REVENUE_METRIC]),
  };
}

function toHourlyRow(item: TikTokReportData["list"][number]): HourlyMetricRow {
  const d = item.dimensions ?? {};
  const m = item.metrics ?? {};
  const campaignId = d["campaign_id"];
  const at = String(d["stat_time_hour"] ?? "");
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):00:00$/.exec(at);
  if (!campaignId || !match) {
    throw new PlatformError("TikTok hourly row is missing campaign_id or a valid stat_time_hour", "tiktok", "bad_shape", false);
  }
  return {
    level: "campaign",
    entityId: String(campaignId),
    entityName: m["campaign_name"] == null ? null : String(m["campaign_name"]),
    date: match[1]!,
    hour: Number(match[2]),
    spend: decimalOrNull(m["spend"]),
    impressions: integerOrNull(m["impressions"]),
    clicks: integerOrNull(m["clicks"]),
    conversions: decimalOrNull(m["conversion"]),
    purchaseValue: null, // not available per hour
  };
}

/** TikTok's request_id differs on every call; the data does not. */
function withoutRequestId(body: TikTokEnvelope<unknown>): unknown {
  const { request_id: _ignored, ...rest } = body;
  return rest;
}

/**
 * Advertiser IDs are long (19 digits). A JSON number that large has already lost
 * precision when parsed, and would silently point at the wrong account: refuse it.
 */
function advertiserId(v: unknown): string {
  if (typeof v === "number" && !Number.isSafeInteger(v)) {
    throw new PlatformError("TikTok returned an advertiser ID as an imprecise number", "tiktok", "bad_shape", false);
  }
  return String(v ?? "").trim();
}

function textOrNull(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t.slice(0, 200) : null;
}

function currencyOrNull(v: unknown): string | null {
  return typeof v === "string" && /^[A-Z]{3}$/.test(v.trim()) ? v.trim() : null;
}

/** Accept IANA names like "Asia/Riyadh" (and "Etc/GMT-3"); anything else is unknown. */
function timezoneOrNull(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(v.trim()) ? v.trim() : null;
}

function decimalOrNull(v: unknown): string | null {
  if (isNoValue(v)) return null;
  return String(v);
}

function integerOrNull(v: unknown): number | null {
  if (isNoValue(v)) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new PlatformError(`TikTok returned a non-integer count: ${String(v)}`, "tiktok", "bad_number", false);
  }
  return n;
}

/**
 * Platform messages end up in logs and sync_runs.error_message: redact any
 * credential the platform echoed back, and keep them short and single-line.
 */
function sanitize(message: unknown, secrets: string[]): string {
  let text = String(message ?? "");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text.replace(/\s+/g, " ").slice(0, 300);
}
