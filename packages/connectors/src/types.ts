/**
 * Platform-neutral connector contract. TikTok is the first implementation;
 * Snapchat, Meta and Google implement the same interface later, so the sync
 * engine never changes per platform.
 *
 * Connectors return numbers AS THE PLATFORM SENT THEM (strings for money,
 * integers for counts). Conversion to minor units happens in the sync, with
 * the account's currency, and never rounds.
 */

export type Platform = "tiktok" | "snapchat" | "meta" | "google_ads" | "google_business_profile" | "zid";
export type MetricLevel = "account" | "campaign" | "adgroup" | "ad";

/** One entity's numbers for one day. `null` means "not provided by platform". */
export interface DailyMetricRow {
  level: MetricLevel;
  entityId: string;
  entityName: string | null;
  date: string; // YYYY-MM-DD in the ad account's timezone
  spend: string | null; // decimal string in account currency, e.g. "12.34"
  impressions: number | null;
  clicks: number | null;
  conversions: string | null; // decimal string; some platforms report fractional conversions
  /** Purchase value as a decimal string in account currency (TikTok: website purchases); null = not provided. */
  purchaseValue: string | null;
  /** In-app purchase value (TikTok "Purchase value (app)"); null = not requested or not provided. */
  appPurchaseValue?: string | null;
  /** TikTok Shop gross revenue (TikTok "Gross revenue (Shop)"); null = not requested or not provided. */
  shopRevenue?: string | null;
}

/** Which sales a client counts as purchase value: the website (always fetched), in-app, TikTok Shop. */
export type ValueSource = "website" | "app" | "shop";
export const VALUE_SOURCES: ValueSource[] = ["website", "app", "shop"];

export interface ReportPage {
  /** API path that produced this page, e.g. "/report/integrated/get/". */
  endpoint: string;
  /** The request parameters (never credentials), stored with the raw payload. */
  requestParams: Record<string, unknown>;
  /** The full response body exactly as received. */
  payload: unknown;
  /**
   * What the content fingerprint is computed over: the payload minus fields
   * that differ on every call without the data changing (e.g. a request id).
   * Identical data then hashes identically across re-runs.
   */
  hashBasis: unknown;
  page: number;
  totalPages: number;
  rows: DailyMetricRow[];
}

export interface DailyReportRequest {
  accessToken: string;
  externalAccountId: string;
  dateFrom: string;
  dateTo: string;
  page: number;
  /** Extra value sources to request (website is always included). */
  valueSources?: ValueSource[];
}

/**
 * The platform's OWN totals for an ad account over a date range, used for
 * reconciliation. Values are as sent (decimal strings / integers); null =
 * not provided.
 */
export interface AccountTotals {
  endpoint: string;
  requestParams: Record<string, unknown>;
  payload: unknown;
  hashBasis: unknown;
  /** True when the platform returned no totals row at all for the range. */
  empty: boolean;
  spend: string | null;
  impressions: number | null;
  clicks: number | null;
  conversions: string | null;
  purchaseValue: string | null;
  appPurchaseValue?: string | null;
  shopRevenue?: string | null;
}

export interface AccountTotalsRequest {
  accessToken: string;
  externalAccountId: string;
  dateFrom: string;
  dateTo: string;
  valueSources?: ValueSource[];
}

/** One campaign's numbers for one hour (platform time zone). Purchase value is not available per hour. */
export interface HourlyMetricRow extends DailyMetricRow {
  hour: number; // 0-23
}

export interface HourlyReportPage extends Omit<ReportPage, "rows"> {
  rows: HourlyMetricRow[];
}

export interface HourlyReportRequest {
  accessToken: string;
  externalAccountId: string;
  day: string;
  page: number;
}

export interface ReportingConnector {
  readonly platform: Platform;
  /** Longest date range one report request may cover. */
  readonly maxDaysPerRequest: number;
  fetchDailyReportPage(req: DailyReportRequest): Promise<ReportPage>;
  /** Platform-reported totals for the whole account and range (max maxDaysPerRequest days). */
  fetchAccountTotals(req: AccountTotalsRequest): Promise<AccountTotals>;
  /** Campaign x hour for one day (optional: platforms without hourly reports omit it). */
  fetchHourlyReportPage?(req: HourlyReportRequest): Promise<HourlyReportPage>;
}

/**
 * An error from a platform API. Messages must never contain credentials.
 * `retryable` marks transient failures (rate limits, server errors).
 */
export class PlatformError extends Error {
  override name = "PlatformError";
  constructor(
    message: string,
    readonly platform: Platform,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Minimal fetch signature so tests can inject a fake HTTP layer. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;
