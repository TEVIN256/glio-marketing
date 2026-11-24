/**
 * TikTok API for Business (Marketing API v1.3): endpoints, parameters and
 * response shapes. This file is the ONLY place these details live.
 *
 * Checked on 2026-11-25 against TikTok's official docs (business-api.tiktok.com/portal/docs,
 * doc ids noted below) and the official SDK (github.com/tiktok/tiktok-business-api-sdk):
 * base URL, authorization and token exchange, advertiser list/info, the
 * integrated report (params, metric names, string values, "-" for no value,
 * "YYYY-MM-DD 00:00:00" days, 30-day / 1000-row limits, page_info), campaign
 * get/status/update, enum values, and the error codes below (ADR-028).
 * Still to confirm on the first real account (TODO(verify) below): the totals
 * row for an inactive range, and the advertiser/info id limit.
 * v2.0 exists (reporting is a POST with advertiser_ids); v1.3 has no announced end date.
 */

export const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3"; // doc 1738373164380162
export const TIKTOK_AUTH_URL = "https://business-api.tiktok.com/portal/auth"; // app_id, redirect_uri, state; doc 1738373141733378
export const TIKTOK_TOKEN_PATH = "/oauth2/access_token/"; // {app_id, secret, auth_code}; long-term token, no refresh
export const TIKTOK_REPORT_PATH = "/report/integrated/get/"; // doc 1740302848100353
/** Advertisers the access token may use (app_id + secret as query params, token in header). Doc 1738455508553729. */
export const TIKTOK_ADVERTISER_GET_PATH = "/oauth2/advertiser/get/";
/** Name, currency and timezone of advertisers (doc 1739593083610113). TODO(verify): no documented id limit; 100 per call is what established clients use (error 40011 = too many ids). */
export const TIKTOK_ADVERTISER_INFO_PATH = "/advertiser/info/";
export const TIKTOK_ADVERTISER_INFO_FIELDS = ["advertiser_id", "name", "currency", "timezone", "display_timezone"];
export const TIKTOK_ADVERTISER_INFO_MAX_IDS = 100;
/**
 * Campaign read and writes (Ads management scope; docs 1739315828649986, 1739320994354178, 1739320422086657).
 * status/update takes 1-20 campaign ids and also accepts DELETE, which GLIO never sends.
 * update: budget in major units; TikTok refuses less than 105% of the campaign's spend so far and,
 * for SAR, a daily budget under 50.
 */
export const TIKTOK_CAMPAIGN_GET_PATH = "/campaign/get/";
export const TIKTOK_CAMPAIGN_STATUS_PATH = "/campaign/status/update/";
export const TIKTOK_CAMPAIGN_UPDATE_PATH = "/campaign/update/";
export const TIKTOK_CAMPAIGN_FIELDS = ["campaign_id", "campaign_name", "operation_status", "budget", "budget_mode"];

/** Maximum days per request with the stat_time_day dimension (365 without a time dimension). */
export const TIKTOK_MAX_DAYS_PER_REPORT = 30;
export const TIKTOK_PAGE_SIZE = 1000; // maximum

/** Campaign x day report parameters. */
export function campaignDailyReportParams(advertiserId: string, dateFrom: string, dateTo: string, page: number) {
  return {
    advertiser_id: advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_CAMPAIGN",
    dimensions: ["campaign_id", "stat_time_day"],
    metrics: ["campaign_name", "spend", "impressions", "clicks", "conversion"],
    // Include deleted campaigns (default is STATUS_NOT_DELETE), so campaign rows add up to the
    // account totals used for reconciliation. filter_value is itself a JSON string (doc 1751443975608321).
    filtering: [{ field_name: "campaign_status", filter_type: "IN", filter_value: JSON.stringify(["STATUS_ALL"]) }],
    start_date: dateFrom,
    end_date: dateTo,
    page,
    page_size: TIKTOK_PAGE_SIZE,
  };
}

/**
 * Account-level totals over the whole range (no day dimension), used for
 * reconciliation: one aggregated row, deleted campaigns included.
 */
export function accountTotalsParams(advertiserId: string, dateFrom: string, dateTo: string) {
  return {
    advertiser_id: advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_ADVERTISER",
    dimensions: ["advertiser_id"],
    metrics: ["spend", "impressions", "clicks", "conversion"],
    start_date: dateFrom,
    end_date: dateTo,
    page: 1,
    page_size: 10,
  };
}

/** Envelope of every TikTok API response: code 0 = success (20001 = partial success). */
export interface TikTokEnvelope<T> {
  code: number; // 0 = success
  message: string;
  request_id?: string;
  data?: T;
}

export interface TikTokReportData {
  list: Array<{
    dimensions: Record<string, string>;
    metrics: Record<string, string | number | null | undefined>;
  }>;
  page_info: { page: number; page_size: number; total_number: number; total_page: number };
}

export interface TikTokTokenData {
  access_token: string;
  advertiser_ids?: string[];
  scope?: unknown;
}

export interface TikTokAdvertiserListData {
  list: Array<{ advertiser_id: string | number; advertiser_name?: string | null }>;
}

export interface TikTokAdvertiserInfoData {
  list: Array<{
    advertiser_id: string | number;
    name?: string | null;
    currency?: string | null;
    timezone?: string | null;
    display_timezone?: string | null;
  }>;
}

export interface TikTokCampaignListData {
  list: Array<{
    campaign_id: string | number;
    campaign_name?: string | null;
    operation_status?: string | null; // "ENABLE" | "DISABLE"
    budget?: string | number | null;
    budget_mode?: string | null; // BUDGET_MODE_DAY | _INFINITE | _TOTAL | _DYNAMIC_DAILY_BUDGET
  }>;
}


/**
 * Business error codes (doc 1737172488964097, rate limits doc 1740029171730433).
 * Retry later: app/advertiser throttling (40016, 40100, 40133), system errors and
 * maintenance (50000, 50002, 51305, 60001), write conflict (40202).
 */
export const TIKTOK_RETRYABLE_CODES: ReadonlySet<number> = new Set([40016, 40100, 40133, 40202, 50000, 50002, 51305, 60001]);
/** The advertiser must connect again: token expired, missing, invalid or revoked; no permission. */
export const TIKTOK_REAUTH_CODES: ReadonlySet<number> = new Set([40001, 40102, 40104, 40105, 40106]);

/** TikTok reports "-" for a metric with no value: that is "not provided", never zero. */
export const isNoValue = (v: unknown) => v === null || v === undefined || v === "" || v === "-";
