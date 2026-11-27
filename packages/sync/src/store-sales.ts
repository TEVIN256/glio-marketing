import { PlatformError, type RedactedOrder, ZID_ORDERS_ENDPOINT, type ZidConnector, type ZidStore, type ZidTokens, utcOffsetFor } from "@glio/connectors";
import { addDays, decimalToMinor, sha256OfJson } from "@glio/core";
import { withRetry, defaultRetry, type RetryOptions } from "./retry.ts";
import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/**
 * Store sales (Zid, read-only; migration 0020, ADR-039).
 *
 * What counts, per store day (by order CREATION time in the store's time zone):
 *  - cancelled: order status canceled/cancelled, or payment voided. Not a sale.
 *  - orders / gross sales: every other order, at its order total (as Zid reports it:
 *    including VAT and shipping), whether paid yet or not (e.g. cash on delivery).
 *  - refunded: among those, payment refunded or status reversed (the full total).
 *  - partially refunded: status partially_reversed; counted, NOT deducted (Zid's list
 *    does not say how much was returned).
 *  - net sales = gross − refunded.
 * A refund is counted on the day the order was created, so re-syncing recent days
 * (the daily job does the last 7) picks up later cancellations and refunds.
 */

export const STORE_DEFAULT_TIMEZONE = "Asia/Riyadh";
/** Refresh well before the 1-year refresh token expires (Zid: "about every 10 months"). */
export const STORE_REFRESH_AFTER_DAYS = 30;
export const STORE_MAX_DAYS = 92;

export interface StoreDayFigures {
  currency: string;
  orders: number;
  grossMinor: bigint;
  cancelledOrders: number;
  refundedOrders: number;
  refundedMinor: bigint;
  partiallyRefundedOrders: number;
  netMinor: bigint;
}

const CANCELLED = new Set(["canceled", "cancelled"]);

/** Pure: one day's redacted orders → figures. Throws rather than guess (mixed currency, missing total). */
export function aggregateStoreDay(orders: RedactedOrder[], fallbackCurrency: string | null): StoreDayFigures | null {
  const currency = (fallbackCurrency ?? orders.find((o) => o.currency_code)?.currency_code ?? null)?.toUpperCase() ?? null;
  if (!currency) return null; // no orders and the store's currency is unknown: nothing to record
  const f: StoreDayFigures = {
    currency, orders: 0, grossMinor: 0n, cancelledOrders: 0, refundedOrders: 0, refundedMinor: 0n, partiallyRefundedOrders: 0, netMinor: 0n,
  };
  for (const o of orders) {
    const status = (o.status ?? "").toLowerCase();
    const payment = (o.payment_status ?? "").toLowerCase();
    if (CANCELLED.has(status) || payment === "voided") {
      f.cancelledOrders += 1;
      continue;
    }
    if (o.currency_code && o.currency_code.toUpperCase() !== currency) {
      throw new PlatformError(`Order ${o.id} is in ${o.currency_code}, the store reports in ${currency}`, "zid", "ZID_MIXED_CURRENCY", false);
    }
    if (o.order_total === null) throw new PlatformError(`Order ${o.id} has no total`, "zid", "ZID_MISSING_TOTAL", false);
    const total = decimalToMinor(o.order_total, currency);
    f.orders += 1;
    f.grossMinor += total;
    if (payment === "refunded" || status === "reversed") {
      f.refundedOrders += 1;
      f.refundedMinor += total;
    } else if (status === "partially_reversed") {
      f.partiallyRefundedOrders += 1;
    }
  }
  f.netMinor = f.grossMinor - f.refundedMinor;
  return f;
}

/** The token bundle kept in the secret store (Vault) as JSON. Never in a table, never logged. */
function packTokens(t: ZidTokens): string {
  return JSON.stringify({ authorization: t.authorization, managerToken: t.managerToken, refreshToken: t.refreshToken });
}
function unpackTokens(value: string): ZidTokens {
  const t = JSON.parse(value) as Partial<ZidTokens>;
  if (!t.authorization || !t.managerToken || !t.refreshToken) throw new Error("Stored store tokens are incomplete");
  return { authorization: t.authorization, managerToken: t.managerToken, refreshToken: t.refreshToken, expiresIn: null };
}
const expiryOf = (t: ZidTokens) => (t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000).toISOString() : null);

export interface ConnectStoreArgs {
  workspaceId: string;
  clientId: string;
  userId: string;
  platform: "zid";
  store: ZidStore;
  tokens: ZidTokens;
  /** From newSecretRef("zid"). */
  secretRef: string;
}

/**
 * Attach a store to a client. Same store again: reconnected (new tokens). A store already
 * attached to another client, or a client that already has a different store, is refused.
 */
export async function connectStore(
  deps: { db: SqlExecutor; secrets: SecretStore },
  args: ConnectStoreArgs,
): Promise<{ connectionId: string; reconnected: boolean }> {
  const out = await deps.db.transaction(async (q) => {
    const [client] = await q("select id from public.clients where workspace_id = $1 and id = $2 for update", [args.workspaceId, args.clientId]);
    if (!client) throw Object.assign(new Error("Client not found in this workspace"), { code: "CLIENT_NOT_FOUND" });
    const [sameStore] = await q(
      "select id, client_id from public.store_connections where workspace_id = $1 and platform = $2 and external_store_id = $3 for update",
      [args.workspaceId, args.platform, args.store.externalId],
    );
    if (sameStore && sameStore.client_id !== args.clientId) {
      throw Object.assign(new Error("This store is connected to another client"), { code: "STORE_CONNECTED_ELSEWHERE" });
    }
    const [clientStore] = await q("select id, external_store_id from public.store_connections where client_id = $1 and platform = $2",
      [args.clientId, args.platform]);
    if (clientStore && clientStore.external_store_id !== args.store.externalId) {
      throw Object.assign(new Error("This client already has a different store"), { code: "STORE_ALREADY_CONNECTED" });
    }
    await deps.secrets.put(args.secretRef, packTokens(args.tokens));
    let id = sameStore?.id as string | undefined;
    let oldRef: string | null = null;
    if (id) {
      await q(
        `update public.store_connections set name = coalesce($2, name), currency = coalesce($3, currency),
                timezone = coalesce($4, timezone), status = 'active', last_error_code = null
         where id = $1`,
        [id, args.store.name, args.store.currency, args.store.timezone],
      );
      const [old] = await q("select secret_ref from public.store_credentials where connection_id = $1", [id]);
      if (old && old.secret_ref !== args.secretRef) oldRef = old.secret_ref as string;
    } else {
      const [row] = await q(
        `insert into public.store_connections (workspace_id, client_id, platform, external_store_id, name, currency, timezone, connected_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [args.workspaceId, args.clientId, args.platform, args.store.externalId, args.store.name, args.store.currency, args.store.timezone, args.userId],
      );
      id = row!.id as string;
    }
    await q(
      `insert into public.store_credentials (connection_id, workspace_id, secret_ref, expires_at, refreshed_at)
       values ($1, $2, $3, $4, now())
       on conflict (connection_id) do update set secret_ref = excluded.secret_ref, expires_at = excluded.expires_at, refreshed_at = now()`,
      [id, args.workspaceId, args.secretRef, expiryOf(args.tokens)],
    );
    await q(
      `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
       values ($1::uuid, 'user', $2::uuid, 'store.connected', 'store_connection', $3::text, $4)`,
      [args.workspaceId, args.userId, id, JSON.stringify({
        platform: args.platform, external_store_id: args.store.externalId, client_id: args.clientId, reconnected: Boolean(sameStore),
      })],
    );
    return { id: id!, oldRef, reconnected: Boolean(sameStore) };
  });
  if (out.oldRef) await deps.secrets.delete?.(out.oldRef);
  return { connectionId: out.id, reconnected: out.reconnected };
}

/** Remove a store connection: its sales, payloads and credential row go by cascade; the tokens leave the secret store. */
export async function disconnectStore(
  deps: { db: SqlExecutor; secrets: SecretStore },
  args: { workspaceId: string; clientId: string; connectionId: string; userId: string },
): Promise<boolean> {
  const out = await deps.db.transaction(async (q) => {
    const [c] = await q(
      `select s.id, s.platform, s.external_store_id, s.name, c.secret_ref from public.store_connections s
       left join public.store_credentials c on c.connection_id = s.id
       where s.id = $1 and s.workspace_id = $2 and s.client_id = $3 for update of s`,
      [args.connectionId, args.workspaceId, args.clientId],
    );
    if (!c) return null;
    await q("delete from public.store_connections where id = $1", [args.connectionId]);
    await q(
      `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
       values ($1::uuid, 'user', $2::uuid, 'store.disconnected', 'store_connection', $3::text, $4)`,
      [args.workspaceId, args.userId, args.connectionId, JSON.stringify({
        platform: c.platform, external_store_id: c.external_store_id, name: c.name, client_id: args.clientId,
      })],
    );
    return (c.secret_ref as string | null) ?? null;
  });
  if (out === null) return false;
  if (out) await deps.secrets.delete?.(out).catch(() => {});
  return true;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  client_id: string;
  platform: string;
  currency: string | null;
  timezone: string | null;
  secret_ref: string;
  refreshed_at: string;
}

async function loadConnection(db: SqlExecutor, connectionId: string): Promise<ConnectionRow> {
  const [c] = await db.query(
    `select s.id, s.workspace_id, s.client_id, s.platform, s.currency, s.timezone, c.secret_ref, c.refreshed_at
     from public.store_connections s join public.store_credentials c on c.connection_id = s.id where s.id = $1`,
    [connectionId],
  );
  if (!c) throw Object.assign(new Error("Store connection not found"), { code: "STORE_NOT_FOUND" });
  return c as ConnectionRow;
}

async function markFailure(db: SqlExecutor, connectionId: string, err: unknown): Promise<void> {
  const code = err instanceof PlatformError ? err.code : "STORE_SYNC_FAILED";
  const reauth = code === "ZID_UNAUTHORIZED" || code === "ZID_TOKEN_FAILED";
  await db.query(
    `update public.store_connections set last_error_code = $2, status = case when $3 then 'needs_reauth' else status end where id = $1`,
    [connectionId, code, reauth],
  );
}

export interface StoreSyncDeps {
  db: SqlExecutor;
  secrets: SecretStore;
  connector: ZidConnector;
  retry?: RetryOptions;
}

/**
 * Fetch and store each store day in [dateFrom, dateTo]. Each day: one order-list request per
 * 100 orders, redacted, archived (deduplicated by content), and its figures upserted.
 */
export async function syncStoreSales(
  deps: StoreSyncDeps,
  args: { connectionId: string; dateFrom: string; dateTo: string },
): Promise<{ days: number; orders: number }> {
  if (args.dateTo < args.dateFrom) throw new Error("dateTo is before dateFrom");
  const c = await loadConnection(deps.db, args.connectionId);
  const tokens = unpackTokens(await deps.secrets.get(c.secret_ref));
  const tz = c.timezone ?? STORE_DEFAULT_TIMEZONE;
  let days = 0;
  let orders = 0;
  try {
    for (let day = args.dateFrom; day <= args.dateTo; day = addDays(day, 1)) {
      if (++days > STORE_MAX_DAYS) throw new Error(`At most ${STORE_MAX_DAYS} days per store sync`);
      const result = await withRetry(() => deps.connector.ordersForDay(tokens, day, utcOffsetFor(tz, day)), deps.retry ?? defaultRetry);
      const figures = aggregateStoreDay(result.orders, c.currency);
      if (!figures) continue;
      orders += figures.orders;
      const payload = { day, time_zone: tz, pages: result.pages, total_reported: result.totalReported, orders: result.orders };
      const sha = sha256OfJson(payload);
      await deps.db.transaction(async (q) => {
        let [p] = await q(
          `insert into public.store_payloads (workspace_id, client_id, connection_id, platform, endpoint, request_params, payload, payload_sha256)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (connection_id, endpoint, payload_sha256) do nothing returning id`,
          [c.workspace_id, c.client_id, c.id, c.platform, ZID_ORDERS_ENDPOINT, JSON.stringify(result.requestParams), JSON.stringify(payload), sha],
        );
        if (!p) [p] = await q("select id from public.store_payloads where connection_id = $1 and endpoint = $2 and payload_sha256 = $3",
          [c.id, ZID_ORDERS_ENDPOINT, sha]);
        await q(
          `insert into public.store_sales_daily (workspace_id, client_id, connection_id, platform, date, currency, orders, gross_sales_minor,
                                                 cancelled_orders, refunded_orders, refunded_minor, partially_refunded_orders, net_sales_minor, raw_payload_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           on conflict (connection_id, date) do update set
             currency = excluded.currency, orders = excluded.orders, gross_sales_minor = excluded.gross_sales_minor,
             cancelled_orders = excluded.cancelled_orders, refunded_orders = excluded.refunded_orders,
             refunded_minor = excluded.refunded_minor, partially_refunded_orders = excluded.partially_refunded_orders,
             net_sales_minor = excluded.net_sales_minor, raw_payload_id = excluded.raw_payload_id, updated_at = now()
           where store_sales_daily.raw_payload_id is distinct from excluded.raw_payload_id`,
          [c.workspace_id, c.client_id, c.id, c.platform, day, figures.currency, figures.orders, String(figures.grossMinor),
            figures.cancelledOrders, figures.refundedOrders, String(figures.refundedMinor), figures.partiallyRefundedOrders,
            String(figures.netMinor), p!.id],
        );
      });
    }
  } catch (err) {
    await markFailure(deps.db, c.id, err);
    throw err;
  }
  await deps.db.query(
    "update public.store_connections set last_synced_at = now(), last_error_code = null, status = 'active' where id = $1",
    [c.id],
  );
  return { days, orders };
}

/**
 * Refresh a store's tokens when the last refresh is older than `afterDays` (Zid's refresh
 * token lives 1 year; a refresh replaces the whole set, so the new set is stored at once).
 */
export async function refreshStoreTokensIfDue(
  deps: { db: SqlExecutor; secrets: SecretStore; refresh: (refreshToken: string) => Promise<ZidTokens> },
  args: { connectionId: string; afterDays?: number; now?: Date },
): Promise<"refreshed" | "not_due"> {
  const c = await loadConnection(deps.db, args.connectionId);
  const now = args.now ?? new Date();
  const ageDays = (now.getTime() - new Date(c.refreshed_at).getTime()) / 86_400_000;
  if (ageDays < (args.afterDays ?? STORE_REFRESH_AFTER_DAYS)) return "not_due";
  try {
    const current = unpackTokens(await deps.secrets.get(c.secret_ref));
    const next = await deps.refresh(current.refreshToken);
    await deps.secrets.put(c.secret_ref, packTokens(next));
    await deps.db.query("update public.store_credentials set refreshed_at = now(), expires_at = coalesce($2, expires_at) where connection_id = $1",
      [c.id, expiryOf(next)]);
    return "refreshed";
  } catch (err) {
    await markFailure(deps.db, c.id, err);
    throw err;
  }
}
