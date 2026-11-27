import { type FetchLike, PlatformError } from "../types.ts";

/**
 * Zid (Saudi e-commerce platform), READ-ONLY: store details and the order list.
 *
 * Verified against Zid's developer docs (docs.zid.sa, read 2026-11-27):
 *  - authorization.md: OAuth 2.0 authorization-code grant, no PKCE, `state` echoed back.
 *    Authorize: https://oauth.zid.sa/oauth/authorize?client_id&redirect_uri&response_type=code&state
 *    Token:     POST https://oauth.zid.sa/oauth/token, form-encoded body (not query parameters).
 *    Response:  { token_type, expires_in (SECONDS), authorization, access_token, refresh_token }.
 *    Every API call sends BOTH `Authorization: Bearer <authorization>` and
 *    `X-Manager-Token: <access_token>`, plus `Accept-Language: en` (else Zid answers in Arabic).
 *    Lifetimes: code 10 min single use; authorization/access_token 3 years (read expires_in);
 *    refresh_token 1 year: refresh on a schedule, not on a 401. A refresh returns a NEW
 *    refresh token and revokes the old one, so the whole set must be replaced.
 *  - store-33664558e0.md: GET /v1/managers/account/store -> { store: { id, title, timezone } }
 *    (scope third_store_details_read).
 *  - localization-33664641e0.md: GET /v1/managers/account/store/localization ->
 *    { localization: { currency: { code } } } (same scope).
 *  - list-of-orders.md: GET /v1/managers/store/orders (scope orders.read), query
 *    page, per_page (max 100), date_from / date_to ('2020-01-01T00:00:00.000+0000'),
 *    date_attribute (created_at | updated_at), payload_type (default "simple", no products).
 *    Response { orders: [...], total_order_count, grand_total }. Each order: id,
 *    order_status { code }, payment_status (pending|paid|refunded|voided), order_total
 *    (string or number), currency_code, source, created_at ('2025-11-12 08:57:35', NO zone).
 *  - rate-limiting: 60 requests/minute per app per store (leaky bucket; 429 when full).
 *
 * Because created_at carries no time zone, GLIO asks for ONE store day at a time with the
 * store's UTC offset written into date_from/date_to, so the day boundaries are explicit.
 *
 * Personal data: orders include customer names, phones, emails and addresses. They are
 * dropped here (redactOrder) and never leave the connector.
 */

export const ZID_OAUTH_BASE = "https://oauth.zid.sa";
export const ZID_API_BASE = "https://api.zid.sa/v1";
export const ZID_ORDERS_ENDPOINT = "/managers/store/orders";
export const ZID_PAGE_SIZE = 100;
/** Safety stop: 50 pages × 100 = 5,000 orders in one store day. */
export const ZID_MAX_PAGES = 50;

export interface ZidTokens {
  /** `authorization` from the token response: sent as `Authorization: Bearer …`. */
  authorization: string;
  /** `access_token` from the token response: sent as `X-Manager-Token`. */
  managerToken: string;
  refreshToken: string;
  /** Lifetime of `authorization` in seconds, as returned. */
  expiresIn: number | null;
}

export interface ZidStore {
  externalId: string;
  name: string | null;
  timezone: string | null;
  currency: string | null;
}

/** An order with everything personal removed: exactly the fields GLIO computes from. */
export interface RedactedOrder {
  id: string;
  created_at: string | null;
  status: string | null;
  payment_status: string | null;
  order_total: string | null;
  currency_code: string | null;
  source: string | null;
}

export interface ZidOrdersDay {
  endpoint: string;
  requestParams: Record<string, string>;
  pages: number;
  totalReported: number | null;
  orders: RedactedOrder[];
}

export interface ZidConnectorOptions {
  fetch?: FetchLike;
}

export class ZidConnector {
  private readonly fetchImpl: FetchLike;

  constructor(opts: ZidConnectorOptions = {}) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  static authorizationUrl(args: { clientId: string; redirectUri: string; state: string }): string {
    const q = new URLSearchParams({ client_id: args.clientId, redirect_uri: args.redirectUri, response_type: "code", state: args.state });
    return `${ZID_OAUTH_BASE}/oauth/authorize?${q.toString()}`;
  }

  exchangeCode(args: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<ZidTokens> {
    return this.token({
      grant_type: "authorization_code", client_id: args.clientId, client_secret: args.clientSecret,
      redirect_uri: args.redirectUri, code: args.code,
    });
  }

  refresh(args: { clientId: string; clientSecret: string; redirectUri: string; refreshToken: string }): Promise<ZidTokens> {
    return this.token({
      grant_type: "refresh_token", refresh_token: args.refreshToken, client_id: args.clientId,
      client_secret: args.clientSecret, redirect_uri: args.redirectUri,
    });
  }

  private async token(form: Record<string, string>): Promise<ZidTokens> {
    let res;
    try {
      res = await this.fetchImpl(`${ZID_OAUTH_BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new PlatformError("Could not reach Zid's sign-in service", "zid", "ZID_NETWORK", true);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status !== 200 || !body) throw statusError(res.status, "ZID_TOKEN_FAILED");
    const authorization = str(body.authorization);
    const managerToken = str(body.access_token);
    const refreshToken = str(body.refresh_token);
    if (!authorization || !managerToken || !refreshToken) {
      throw new PlatformError("Zid's token response is missing a token", "zid", "ZID_TOKEN_FAILED", false);
    }
    const expiresIn = Number(body.expires_in);
    return { authorization, managerToken, refreshToken, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null };
  }

  async getStore(tokens: ZidTokens): Promise<ZidStore> {
    const body = await this.get(tokens, "/managers/account/store", {});
    const store = (body.store ?? {}) as Record<string, unknown>;
    const id = store.id;
    if (id === undefined || id === null || String(id).trim() === "") {
      throw new PlatformError("Zid did not return the store id", "zid", "ZID_NO_STORE", false);
    }
    let currency: string | null = null;
    try {
      const loc = await this.get(tokens, "/managers/account/store/localization", {});
      const code = str(((loc.localization as Record<string, unknown> | undefined)?.currency as Record<string, unknown> | undefined)?.code);
      currency = code && /^[A-Z]{3}$/.test(code) ? code : null;
    } catch {
      currency = null; // the orders carry their own currency; this is only the default
    }
    return { externalId: String(id), name: str(store.title), timezone: str(store.timezone), currency };
  }

  /** Every order CREATED on one store day (00:00–23:59:59.999 at `utcOffset`, e.g. "+0300"), redacted. */
  async ordersForDay(tokens: ZidTokens, day: string, utcOffset: string): Promise<ZidOrdersDay> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[+-]\d{4}$/.test(utcOffset)) throw new Error(`Bad day or offset: ${day} ${utcOffset}`);
    const base = {
      payload_type: "simple",
      per_page: String(ZID_PAGE_SIZE),
      date_attribute: "created_at",
      date_from: `${day}T00:00:00.000${utcOffset}`,
      date_to: `${day}T23:59:59.999${utcOffset}`,
    };
    const orders: RedactedOrder[] = [];
    let totalReported: number | null = null;
    let page = 1;
    for (; ; page++) {
      if (page > ZID_MAX_PAGES) throw new PlatformError(`More than ${ZID_MAX_PAGES} pages of orders in one day`, "zid", "ZID_TOO_MANY_ORDERS", false);
      const body = await this.get(tokens, ZID_ORDERS_ENDPOINT, { ...base, page: String(page) });
      const list = Array.isArray(body.orders) ? (body.orders as Array<Record<string, unknown>>) : null;
      if (!list) throw new PlatformError("Zid's order list response has no orders array", "zid", "ZID_BAD_RESPONSE", false);
      const total = Number(body.total_order_count);
      if (Number.isFinite(total)) totalReported = total;
      orders.push(...list.map(redactOrder));
      if (list.length < ZID_PAGE_SIZE) break;
      if (totalReported !== null && orders.length >= totalReported) break;
    }
    // The same order twice (pages shifting while new orders arrive) would double count it.
    const unique = [...new Map(orders.map((o) => [o.id, o])).values()];
    return { endpoint: ZID_ORDERS_ENDPOINT, requestParams: base, pages: page, totalReported, orders: unique };
  }

  private async get(tokens: ZidTokens, path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams(query).toString();
    let res;
    try {
      res = await this.fetchImpl(`${ZID_API_BASE}${path}${qs ? `?${qs}` : ""}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Language": "en",
          Authorization: `Bearer ${tokens.authorization}`,
          "X-Manager-Token": tokens.managerToken,
        },
      });
    } catch {
      throw new PlatformError("Could not reach Zid", "zid", "ZID_NETWORK", true);
    }
    if (res.status !== 200) throw statusError(res.status, "ZID_HTTP_ERROR");
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new PlatformError("Zid returned an unreadable response", "zid", "ZID_BAD_RESPONSE", true);
    return body;
  }
}

/** Keep only what the figures need. Never customer, address, products or payment details. */
export function redactOrder(o: Record<string, unknown>): RedactedOrder {
  const status = o.order_status as Record<string, unknown> | undefined;
  const total = o.order_total;
  return {
    id: String(o.id),
    created_at: str(o.created_at),
    status: status && (typeof status.code === "string" || typeof status.code === "number") ? String(status.code) : null,
    payment_status: str(o.payment_status),
    order_total: typeof total === "number" || typeof total === "string" ? String(total) : null,
    currency_code: str(o.currency_code),
    source: str(o.source),
  };
}

/** "+0300" for a time zone on a given day (Asia/Riyadh has no daylight saving; others might). */
export function utcOffsetFor(timeZone: string, day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? `${m[1]}${m[2]}${m[3]}` : "+0000";
}

function statusError(status: number, fallback: string): PlatformError {
  if (status === 401) return new PlatformError("Zid refused the store's sign-in (reconnect needed)", "zid", "ZID_UNAUTHORIZED", false);
  if (status === 403) return new PlatformError("Zid refused access (permission missing or waiting for the merchant's approval)", "zid", "ZID_FORBIDDEN", false);
  if (status === 429) return new PlatformError("Zid rate limit reached", "zid", "ZID_RATE_LIMITED", true);
  if (status >= 500) return new PlatformError(`Zid server error ${status}`, "zid", "ZID_SERVER_ERROR", true);
  return new PlatformError(`Zid returned HTTP ${status}`, "zid", fallback, false);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
