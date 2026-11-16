import {
  type DailyMetricRow, type DailyReportRequest, type FetchLike, PlatformError, type ReportingConnector, type ReportPage,
} from "../types.js";
import {
  TIKTOK_API_BASE, TIKTOK_AUTH_URL, TIKTOK_MAX_DAYS_PER_REPORT, TIKTOK_REPORT_PATH, TIKTOK_TOKEN_PATH,
  campaignDailyReportParams, type TikTokEnvelope, type TikTokReportData, type TikTokTokenData,
} from "./api.js";

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
    url.searchParams.set("app_id", args.appId); // TODO(verify) parameter names
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

  async fetchDailyReportPage(req: DailyReportRequest): Promise<ReportPage> {
    const params = campaignDailyReportParams(req.externalAccountId, req.dateFrom, req.dateTo, req.page);
    const url = new URL(this.apiBase + TIKTOK_REPORT_PATH);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    const res = await this.fetch(url.toString(), { method: "GET", headers: { "Access-Token": req.accessToken } });
    const body = await this.readEnvelope<TikTokReportData>(res, TIKTOK_REPORT_PATH, [req.accessToken]);
    const data = body.data;
    if (!data || !Array.isArray(data.list) || !data.page_info) {
      throw new PlatformError("TikTok report response is missing data.list or data.page_info", "tiktok", "bad_shape", false);
    }

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
      // TODO(verify): mark TikTok's rate-limit / transient business codes as retryable.
      throw new PlatformError(
        `TikTok ${path} error ${body.code}: ${sanitize(body.message, secrets)}`, "tiktok", `tiktok_${body.code}`, false,
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
  };
}

/** TikTok's request_id differs on every call; the data does not. */
function withoutRequestId(body: TikTokEnvelope<unknown>): unknown {
  const { request_id: _ignored, ...rest } = body;
  return rest;
}

function decimalOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function integerOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
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
