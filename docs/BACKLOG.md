# Backlog

Builds agreed or proposed but not started. Newest decisions first within each section.
When an item is built, move its outcome to `DECISIONS.md` (ADR) and `RUNBOOK.md`, and delete it here.

## Next

### Zid store connection: real sales next to ad-reported sales (requested 2026-11-26)

WAKE UP sells on Zid. Connect a merchant's Zid store, read-only, to compare what ad platforms claim with what the store
actually sold.

- **Store sales** tile per day/period: orders, gross sales, discounts, refunds/cancellations → net sales.
- **Overall ROAS:** store sales ÷ total ad spend across channels, independent of platform attribution.
- **Tracking check:** TikTok-reported purchases vs real orders.
  - Flag likely double counting when TikTok reports more purchases than the store had orders.
  - Flag a likely broken pixel when there are many orders but almost no TikTok purchases.
- **Privacy:** store daily aggregates only, never customer names, phones or addresses (PDPL data minimisation).
- **Needs:**
  - a Zid partner/developer account and app approval (owner, like TikTok);
  - verified API details (research in progress);
  - an OAuth "Connect Zid" flow;
  - a daily sync, optionally order webhooks;
  - a migration for store daily totals.
- **Research (2026-11-26).** Sources: search excerpts of docs.zid.sa and help-partner.zid.sa (the pages themselves
  were not reachable from the build environment), plus Zid's official GitHub (sdk-python, sample apps). To confirm on a
  development store before relying on it.
  - **OAuth:**
    - `https://oauth.zid.sa/oauth/authorize` (code flow, `state`), then `POST https://oauth.zid.sa/oauth/token`.
    - The token response contains `authorization`, `access_token`, `refresh_token` and `expires_in` (about 1 year).
    - API calls send `Authorization: Bearer <authorization>` plus `X-Manager-Token: <access_token>`.
    - Refresh before expiry. Uninstall revokes the tokens.
  - **Scopes:** `orders.read` and `third_store_details_read`.
  - **Orders:**
    - `GET https://api.zid.sa/v1/managers/store/orders`, paginated with `page`/`per_page` (max 100).
    - Date filter is on the creation date. The parameter name (`date_from` or `dateFrom`) is unconfirmed.
    - Statuses: `new`, `preparing`, `ready`, `indelivery`, `delivered`, `cancelled`, `reversed`/`partially_reversed`.
    - `payment_status`: `pending`, `paid`, `refunded`, `voided`.
    - Refunds are reverse orders and credit notes.
  - **No sales-summary endpoint:** daily totals must be summed from orders.
  - **Personal data:** every order includes customer details, so strip them on ingest and store only aggregates.
  - **Attribution:** no UTM or traffic-source fields (`source` is the sales channel only). So the first version gives
    overall ROAS and the tracking check, not per-channel attribution.
  - **Store details:** `GET /v1/managers/account/store` (timezone) and `/account/store/localization` (currency). The old
    `/managers/profile` endpoint was retired on 2026-09-30.
  - **Webhooks:** `order.create`, `order.status.update` and `order.payment_status.update`. They carry no signature (only
    optional Basic Auth), so the daily sync stays the source of truth.
  - **Rate limit:** 60 requests/min per app per store.
  - **Unconfirmed:** the time zone of `created_at`, and how partial refunds appear in amounts.
- **Access route:**
  - **Private app per merchant (start here):** Partner Dashboard → My Apps → Create → Private, using the merchant's
    Store ID. No Zid review. The merchant's plan must include API access ("Professional", or the "API Access" /
    "Private Connection" add-on), which may be a cost for the merchant.
  - **Public App Market app (later, to scale):** needs a signed partnership agreement, pricing plans, a privacy
    policy, a support channel, a testing video and Zid's review.
- **Salla:** later, with the same design.

### Break-even ROAS on the dashboard

- Show a break-even line or marker on the ROAS tile and in the campaign table.
- Break-even ROAS = 1 ÷ gross margin.
- **Needs from the owner:** each client's approximate gross margin (a client setting, owners and managers edit).

## Later

- **Report and figure views in the audit log.** Only client dashboards write `client.viewed` today (COMPLIANCE.md:
  "Partial").
- **Disconnect TikTok from inside GLIO**, including token revocation at TikTok (`/oauth2/revoke_token/`).
  - Deleting a client removes GLIO's data and the Vault token.
  - TikTok-side revocation is still manual.
- **Workspace and user-account deletion.** Currently on request by email (COMPLIANCE.md).
- **Other purchase values:**
  - in-app: `total_purchase_value`
  - TikTok Shop: `total_onsite_shopping_value`
  - Only website purchases are fetched now (ADR-031).
- **TikTok Reporting API v2.0.** v1.3 has no announced end date. When it gets one, move the report calls behind the
  same connector interface (ADR-028).
- **More channels:** Snapchat, Meta, Google Ads. The connector interface is ready; each needs its own platform app
  review.
