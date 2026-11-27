import { ZidConnector } from "@glio/connectors";
import { addDays } from "@glio/core";
import { STORE_MAX_DAYS, type SqlExecutor, VaultSecretStore, refreshStoreTokensIfDue, syncStoreSales } from "@glio/sync";
import type { Period } from "./delta";
import { env } from "./env";

/**
 * SERVER ONLY. Store sales (Zid, ADR-039): sync, and the client page's store view.
 * Callers check permissions first (clientAccess) — these run as the server.
 */

export interface StoreConnection {
  id: string;
  name: string | null;
  externalStoreId: string;
  currency: string | null;
  status: "active" | "needs_reauth";
  lastErrorCode: string | null;
  lastSyncedAt: string | null;
}

export type TrackingVerdict = "double_counting" | "pixel_missing" | "consistent" | "not_enough_data";

export interface StoreView {
  connection: StoreConnection;
  /** Days in the period that have store figures. */
  daysWithData: number;
  periodDays: number;
  currency: string | null;
  orders: number;
  grossMinor: bigint;
  refundedMinor: bigint;
  netMinor: bigint;
  cancelledOrders: number;
  partiallyRefundedOrders: number;
  /** TikTok spend and TikTok-reported WEBSITE purchase value on the days that have store figures. */
  adSpendMinor: bigint | null;
  tiktokWebValueMinor: bigint | null;
  tracking: TrackingVerdict;
}

/** Sync (and, when due, refresh the tokens of) the client's Zid store for a period. Returns 0 when none is connected. */
export async function syncClientStore(db: SqlExecutor, ws: string, client: string, from: string, to: string): Promise<number> {
  const [c] = await db.query(
    "select id from public.store_connections where workspace_id = $1 and client_id = $2 and platform = 'zid'",
    [ws, client],
  );
  if (!c || !env.zidConfigured()) return 0;
  const secrets = new VaultSecretStore(db);
  const connector = new ZidConnector();
  await refreshStoreTokensIfDue({
    db, secrets,
    refresh: (refreshToken) => connector.refresh({
      clientId: env.zidClientId(), clientSecret: env.zidClientSecret(), redirectUri: env.zidRedirectUri(), refreshToken,
    }),
  }, { connectionId: c.id });
  const earliest = addDays(to, -(STORE_MAX_DAYS - 1));
  await syncStoreSales({ db, secrets, connector }, { connectionId: c.id, dateFrom: from < earliest ? earliest : from, dateTo: to });
  return 1;
}

/**
 * The tracking check: how TikTok's reported website purchase value compares with what the
 * store actually sold over the same days. TikTok only counts sales it attributes to its ads,
 * so LESS than the store is normal. MORE than the store usually means the purchase event fires
 * twice (or for non-purchases); almost nothing while the store sells and ads run suggests the
 * pixel or its purchase event is not set up.
 */
export function trackingVerdict(a: { storeGrossMinor: bigint; storeOrders: number; tiktokWebValueMinor: bigint | null; adSpendMinor: bigint | null }): TrackingVerdict {
  if (a.tiktokWebValueMinor === null || a.adSpendMinor === null || a.adSpendMinor === 0n || a.storeOrders < 5) return "not_enough_data";
  // More than the whole store sold (5% tolerance for timing: TikTok attributes by click/view time).
  if (a.tiktokWebValueMinor * 100n > a.storeGrossMinor * 105n) return "double_counting";
  // Under 1% of store sales while ads spend and the store had at least 20 orders.
  if (a.storeOrders >= 20 && a.tiktokWebValueMinor * 100n < a.storeGrossMinor) return "pixel_missing";
  return "consistent";
}

export async function loadStoreView(db: SqlExecutor, clientId: string, period: Period): Promise<StoreView | null> {
  const [c] = await db.query(
    `select id, name, external_store_id, currency, status, last_error_code, last_synced_at
     from public.store_connections where client_id = $1 and platform = 'zid'`,
    [clientId],
  );
  if (!c) return null;
  const [s] = await db.query(
    `select count(*)::int as days, count(distinct currency)::int as currencies, min(currency) as currency,
            coalesce(sum(orders), 0)::int as orders, coalesce(sum(gross_sales_minor), 0)::text as gross,
            coalesce(sum(refunded_minor), 0)::text as refunded, coalesce(sum(net_sales_minor), 0)::text as net,
            coalesce(sum(cancelled_orders), 0)::int as cancelled, coalesce(sum(partially_refunded_orders), 0)::int as partial
     from public.store_sales_daily where connection_id = $1 and date between $2 and $3`,
    [c.id, period.from, period.to],
  );
  const currency = s!.currencies === 1 ? (s!.currency as string) : null;
  // TikTok on exactly the days that have store figures (so a half-synced period can't skew ROAS),
  // in the same currency only (no conversion, ever).
  const [t] = await db.query(
    `select count(distinct m.currency)::int as currencies, min(m.currency) as currency,
            sum(m.spend_minor)::text as spend, sum(m.purchase_value_minor)::text as web_value,
            count(*)::int as n, count(m.purchase_value_minor)::int as n_value
     from public.metric_daily m
     where m.client_id = $1 and m.platform = 'tiktok' and m.level = 'campaign' and m.date between $2 and $3
       and exists (select 1 from public.store_sales_daily s where s.connection_id = $4 and s.date = m.date)`,
    [clientId, period.from, period.to, c.id],
  );
  const sameCurrency = t!.n > 0 && t!.currencies === 1 && currency !== null && t!.currency === currency;
  const adSpendMinor = sameCurrency && t!.spend !== null ? BigInt(t!.spend) : null;
  const tiktokWebValueMinor = sameCurrency && t!.n_value === t!.n && t!.web_value !== null ? BigInt(t!.web_value) : null;
  const grossMinor = BigInt(s!.gross);
  const periodDays = Math.round((Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / 86_400_000) + 1;
  return {
    connection: {
      id: c.id, name: c.name, externalStoreId: c.external_store_id, currency: c.currency, status: c.status,
      lastErrorCode: c.last_error_code, lastSyncedAt: c.last_synced_at ? new Date(c.last_synced_at).toISOString() : null,
    },
    daysWithData: s!.days, periodDays, currency,
    orders: s!.orders, grossMinor, refundedMinor: BigInt(s!.refunded), netMinor: BigInt(s!.net),
    cancelledOrders: s!.cancelled, partiallyRefundedOrders: s!.partial,
    adSpendMinor, tiktokWebValueMinor,
    tracking: trackingVerdict({ storeGrossMinor: grossMinor, storeOrders: s!.orders, tiktokWebValueMinor, adSpendMinor }),
  };
}
