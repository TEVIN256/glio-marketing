import {
  type AccountTotals, type AccountTotalsRequest, type DailyMetricRow, type DailyReportRequest, type FetchLike,
  PlatformError, type ReportingConnector, type ReportPage,
} from "../types.ts";

/**
 * Snapchat Marketing API, READ-ONLY reporting (GLIO never writes to Snapchat).
 *
 * Verified against developers.snap.com (read 2026-11-27):
 *  - authentication.md: OAuth 2.0 code grant.
 *    Authorize: https://accounts.snapchat.com/login/oauth2/authorize?client_id&redirect_uri&response_type=code&scope&state
 *    Token:     POST https://accounts.snapchat.com/login/oauth2/access_token (form body), grant_type
 *               authorization_code (with redirect_uri) or refresh_token.
 *    Response:  { access_token, refresh_token, expires_in: 3600, token_type: "Bearer" }. Access tokens
 *               last ~1 hour; the refresh token is long-lived. Scope "snapchat-marketing-api" is the
 *               only Ads API scope (it covers read AND write; GLIO only reads).
 *  - organizations.md: GET /v1/me/organizations?with_ad_accounts=true -> organizations[].organization
 *    .ad_accounts[] { id, name, currency, timezone, status }.
 *  - measurement.md: GET /v1/adaccounts/{id}/stats, granularity DAY + breakdown=campaign (campaign
 *    breakdown is only on the ad account endpoint); start/end must be day boundaries in the ad account's
 *    time zone, at most 31 days apart; response timeseries_stats[0].timeseries_stat.breakdown_stats
 *    .campaign[] { id, timeseries[] { start_time, end_time, stats } }; `limit` <= 200 entities per page,
 *    next page in paging.next_link. The AD ACCOUNT entity itself only reports `spend` (used for
 *    reconciliation). Metrics are finalised 48 hours after the end of the day. Oversized responses fail
 *    with 400 E9001 (not retryable).
 *  - Metric names: impressions, swipes (Snap's click equivalent), spend, conversion_purchases,
 *    conversion_purchases_value; default attribution 28-day swipe / 1-day view.
 *  - monetary-values.md: money is micro-currency (1.00 = 1,000,000).
 *  - api-patterns.md: GET /v1/adaccounts/{id}/campaigns (paged, limit 50-1000, paging.next_link).
 *  - rate-limits.md: ~10 requests/second per token; 429 when exceeded.
 */

export const SNAPCHAT_AUTH_URL = "https://accounts.snapchat.com/login/oauth2/authorize";
export const SNAPCHAT_TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
export const SNAPCHAT_API_BASE = "https://adsapi.snapchat.com/v1";
export const SNAPCHAT_SCOPE = "snapchat-marketing-api";
export const SNAPCHAT_MAX_DAYS = 31;
export const SNAPCHAT_STATS_FIELDS = ["impressions", "swipes", "spend", "conversion_purchases", "conversion_purchases_value"] as const;
const STATS_PAGE_LIMIT = 200;
const MAX_LIST_PAGES = 50;

export interface SnapchatTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
}

export interface SnapchatAdAccount {
  externalId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

export interface SnapchatConnectorOptions {
  fetch?: FetchLike;
  apiBase?: string;
}

type Json = Record<string, unknown>;

export class SnapchatConnector implements ReportingConnector {
  readonly platform = "snapchat" as const;
  readonly maxDaysPerRequest = SNAPCHAT_MAX_DAYS;
  readonly accountTotalsMetrics = ["spend"] as const;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  /** Per instance: account time zone, campaign names, and next-page links of a stats request. */
  private readonly accounts = new Map<string, { timezone: string; currency: string | null }>();
  private readonly campaignNames = new Map<string, Map<string, string>>();
  private readonly nextLinks = new Map<string, string>();

  constructor(opts: SnapchatConnectorOptions = {}) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.apiBase = opts.apiBase ?? SNAPCHAT_API_BASE;
  }

  static authorizationUrl(args: { clientId: string; redirectUri: string; state: string }): string {
    const q = new URLSearchParams({
      client_id: args.clientId, redirect_uri: args.redirectUri, response_type: "code", scope: SNAPCHAT_SCOPE, state: args.state,
    });
    return `${SNAPCHAT_AUTH_URL}?${q.toString()}`;
  }

  exchangeCode(args: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<SnapchatTokens> {
    return this.token({
      grant_type: "authorization_code", client_id: args.clientId, client_secret: args.clientSecret, code: args.code, redirect_uri: args.redirectUri,
    });
  }

  /** A fresh access token. Snap may or may not rotate the refresh token; the one returned (or the old one) is kept. */
  refresh(args: { clientId: string; clientSecret: string; refreshToken: string }): Promise<SnapchatTokens> {
    return this.token({
      grant_type: "refresh_token", client_id: args.clientId, client_secret: args.clientSecret, refresh_token: args.refreshToken,
    }, args.refreshToken);
  }

  private async token(form: Record<string, string>, refreshTokenFallback?: string): Promise<SnapchatTokens> {
    let res;
    try {
      res = await this.fetchImpl(SNAPCHAT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new PlatformError("Could not reach Snapchat's sign-in service", "snapchat", "SNAPCHAT_NETWORK", true);
    }
    const body = (await res.json().catch(() => null)) as Json | null;
    if (res.status !== 200 || !body) {
      if (res.status >= 500 || res.status === 429) throw statusError(res.status, null);
      throw new PlatformError(`Snapchat refused the token request (HTTP ${res.status})`, "snapchat", "SNAPCHAT_TOKEN_FAILED", false);
    }
    const accessToken = str(body.access_token);
    const refreshToken = str(body.refresh_token) ?? refreshTokenFallback ?? null;
    if (!accessToken || !refreshToken) throw new PlatformError("Snapchat's token response is missing a token", "snapchat", "SNAPCHAT_TOKEN_FAILED", false);
    const expiresIn = Number(body.expires_in);
    return { accessToken, refreshToken, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null };
  }

  /** Every ad account the signed-in user can see, across their organizations. */
  async listAdAccounts(accessToken: string): Promise<SnapchatAdAccount[]> {
    const body = await this.get(accessToken, `${this.apiBase}/me/organizations?with_ad_accounts=true`);
    const out = new Map<string, SnapchatAdAccount>();
    for (const o of arr(body.organizations)) {
      const org = (o as Json).organization as Json | undefined;
      for (const a of arr(org?.ad_accounts)) {
        const acc = a as Json;
        const id = str(acc.id);
        if (!id || out.has(id)) continue;
        const currency = str(acc.currency);
        out.set(id, { externalId: id, name: str(acc.name), currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null, timezone: str(acc.timezone) });
      }
    }
    return [...out.values()];
  }

  async fetchDailyReportPage(req: DailyReportRequest): Promise<ReportPage> {
    const acct = await this.account(req.accessToken, req.externalAccountId);
    const names = await this.names(req.accessToken, req.externalAccountId);
    const requestParams = {
      granularity: "DAY",
      breakdown: "campaign",
      fields: SNAPCHAT_STATS_FIELDS.join(","),
      start_time: dayStart(req.dateFrom, acct.timezone),
      end_time: dayStart(addDays(req.dateTo, 1), acct.timezone),
      omit_empty: "true",
      limit: String(STATS_PAGE_LIMIT),
    };
    const key = `${req.externalAccountId}|${req.dateFrom}|${req.dateTo}`;
    const path = `/adaccounts/${encodeURIComponent(req.externalAccountId)}/stats`;
    let url: string;
    if (req.page === 1) url = `${this.apiBase}${path}?${new URLSearchParams(requestParams).toString()}`;
    else {
      const next = this.nextLinks.get(`${key}|${req.page}`);
      if (!next) throw new Error(`No next page ${req.page} for this Snapchat stats request`);
      url = next;
    }
    const body = await this.get(req.accessToken, url);
    const stat = (arr(body.timeseries_stats)[0] as Json | undefined)?.timeseries_stat as Json | undefined;
    const campaigns = arr((stat?.breakdown_stats as Json | undefined)?.campaign) as Json[];
    const rows: DailyMetricRow[] = [];
    for (const c of campaigns) {
      const id = str(c.id);
      if (!id) continue;
      for (const t of arr(c.timeseries) as Json[]) {
        const start = str(t.start_time);
        if (!start) continue;
        const date = localDate(start, acct.timezone);
        if (date < req.dateFrom || date > req.dateTo) continue;
        const s = (t.stats ?? {}) as Json;
        rows.push({
          level: "campaign", entityId: id, entityName: names.get(id) ?? null, date,
          spend: microToDecimal(s.spend, acct.currency),
          impressions: int(s.impressions),
          clicks: int(s.swipes),
          conversions: s.conversion_purchases === undefined || s.conversion_purchases === null ? null : String(int(s.conversion_purchases)),
          purchaseValue: microToDecimal(s.conversion_purchases_value, acct.currency),
        });
      }
    }
    const next = str((body.paging as Json | undefined)?.next_link);
    if (next) this.nextLinks.set(`${key}|${req.page + 1}`, this.safeLink(next));
    return {
      endpoint: path.replace(encodeURIComponent(req.externalAccountId), "{ad_account_id}"),
      requestParams: { ...requestParams, page: req.page },
      payload: body,
      hashBasis: withoutRequestId(body),
      page: req.page,
      totalPages: next ? req.page + 1 : req.page,
      rows,
    };
  }

  /** Snap's own total SPEND for the account (the only metric the ad account entity reports). */
  async fetchAccountTotals(req: AccountTotalsRequest): Promise<AccountTotals> {
    const acct = await this.account(req.accessToken, req.externalAccountId);
    const requestParams = {
      granularity: "TOTAL", fields: "spend",
      start_time: dayStart(req.dateFrom, acct.timezone), end_time: dayStart(addDays(req.dateTo, 1), acct.timezone),
    };
    const path = `/adaccounts/${encodeURIComponent(req.externalAccountId)}/stats`;
    const body = await this.get(req.accessToken, `${this.apiBase}${path}?${new URLSearchParams(requestParams).toString()}`);
    const total = (arr(body.total_stats)[0] as Json | undefined)?.total_stat as Json | undefined;
    const stats = total?.stats as Json | undefined;
    return {
      endpoint: path.replace(encodeURIComponent(req.externalAccountId), "{ad_account_id}"),
      requestParams, payload: body, hashBasis: withoutRequestId(body),
      empty: !stats,
      spend: stats ? microToDecimal(stats.spend, acct.currency) : null,
      impressions: null, clicks: null, conversions: null, purchaseValue: null,
    };
  }

  private async account(accessToken: string, id: string): Promise<{ timezone: string; currency: string | null }> {
    const cached = this.accounts.get(id);
    if (cached) return cached;
    const body = await this.get(accessToken, `${this.apiBase}/adaccounts/${encodeURIComponent(id)}`);
    const acc = (arr(body.adaccounts)[0] as Json | undefined)?.adaccount as Json | undefined;
    const timezone = str(acc?.timezone);
    if (!timezone) throw new PlatformError("Snapchat did not return the ad account's time zone", "snapchat", "SNAPCHAT_NO_TIMEZONE", false);
    const currency = str(acc?.currency);
    const out = { timezone, currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null };
    this.accounts.set(id, out);
    return out;
  }

  private async names(accessToken: string, id: string): Promise<Map<string, string>> {
    const cached = this.campaignNames.get(id);
    if (cached) return cached;
    const names = new Map<string, string>();
    let url: string | null = `${this.apiBase}/adaccounts/${encodeURIComponent(id)}/campaigns?limit=1000`;
    for (let i = 0; url && i < MAX_LIST_PAGES; i++) {
      const body = await this.get(accessToken, url);
      for (const c of arr(body.campaigns)) {
        const camp = (c as Json).campaign as Json | undefined;
        const cid = str(camp?.id);
        if (cid) names.set(cid, str(camp?.name) ?? cid);
      }
      const next = str((body.paging as Json | undefined)?.next_link);
      url = next ? this.safeLink(next) : null;
    }
    this.campaignNames.set(id, names);
    return names;
  }

  /** Never send the token anywhere but Snap's API host. */
  private safeLink(link: string): string {
    if (!link.startsWith(`${this.apiBase}/`)) throw new PlatformError("Snapchat returned a next-page link to another host", "snapchat", "SNAPCHAT_BAD_RESPONSE", false);
    return link;
  }

  private async get(accessToken: string, url: string): Promise<Json> {
    let res;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    } catch {
      throw new PlatformError("Could not reach Snapchat", "snapchat", "SNAPCHAT_NETWORK", true);
    }
    const body = (await res.json().catch(() => null)) as Json | null;
    if (res.status !== 200) throw statusError(res.status, body);
    if (!body) throw new PlatformError("Snapchat returned an unreadable response", "snapchat", "SNAPCHAT_BAD_RESPONSE", true);
    if (String(body.request_status ?? "").toUpperCase() !== "SUCCESS") {
      throw new PlatformError(`Snapchat request failed: ${String(body.display_message ?? body.error_code ?? "unknown")}`.slice(0, 300),
        "snapchat", String(body.error_code ?? "SNAPCHAT_REQUEST_FAILED"), false);
    }
    return body;
  }
}

/**
 * Micro-currency (1.00 = 1,000,000) to a decimal string in the currency's minor units, rounded half-up.
 * Snapchat reports money to the millionth; ledgers and Ads Manager show the currency's own decimals
 * (SAR: 2). The exact micro value stays in the archived raw payload. null = not provided.
 */
export function microToDecimal(value: unknown, currency: string | null, digitsOverride?: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "number" ? (Number.isSafeInteger(value) ? String(value) : "") : String(value).trim();
  if (!/^\d+$/.test(text)) throw new PlatformError(`Not a micro-currency amount: ${String(value)}`, "snapchat", "SNAPCHAT_BAD_AMOUNT", false);
  const digits = digitsOverride ?? (currency && ["KWD", "BHD", "OMR", "JOD"].includes(currency) ? 3 : currency && ["JPY", "KRW"].includes(currency) ? 0 : 2);
  const divisor = 10n ** BigInt(6 - digits);
  const micro = BigInt(text);
  const minor = (micro + divisor / 2n) / divisor;
  if (digits === 0) return minor.toString();
  const s = minor.toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** "2026-11-01T00:00:00.000+03:00": local midnight of a day in an IANA time zone. */
export function dayStart(day: string, timeZone: string): string {
  return `${day}T00:00:00.000${isoOffset(timeZone, day)}`;
}

/** The calendar date (YYYY-MM-DD) of an instant, in an IANA time zone. */
export function localDate(instant: string, timeZone: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) throw new PlatformError(`Unreadable time from Snapchat: ${instant}`, "snapchat", "SNAPCHAT_BAD_RESPONSE", false);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function isoOffset(timeZone: string, day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  // The offset in effect at local midnight: probe a few hours either side of UTC midnight.
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(at.getTime() + 12 * 3_600_000)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? `${m[1]}${m[2]}:${m[3]}` : "+00:00";
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function statusError(status: number, body: Json | null): PlatformError {
  const code = body && typeof body.error_code === "string" ? body.error_code : null;
  if (status === 401) return new PlatformError("Snapchat refused the sign-in (reconnect needed)", "snapchat", "SNAPCHAT_UNAUTHORIZED", false);
  if (status === 403) return new PlatformError("Snapchat refused access to this ad account", "snapchat", "SNAPCHAT_FORBIDDEN", false);
  if (status === 429) return new PlatformError("Snapchat rate limit reached", "snapchat", "SNAPCHAT_RATE_LIMITED", true);
  if (status >= 500) return new PlatformError(`Snapchat server error ${status}`, "snapchat", "SNAPCHAT_SERVER_ERROR", true);
  if (code === "E9001") return new PlatformError("Snapchat's response was too large; use a shorter range", "snapchat", "SNAPCHAT_TOO_LARGE", false);
  return new PlatformError(`Snapchat returned HTTP ${status}${code ? ` (${code})` : ""}`, "snapchat", code ?? "SNAPCHAT_HTTP_ERROR", false);
}

function withoutRequestId(body: Json): Json {
  const { request_id: _ignored, ...rest } = body;
  return rest;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function int(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
