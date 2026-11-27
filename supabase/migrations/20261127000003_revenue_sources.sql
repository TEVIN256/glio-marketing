-- =============================================================================
-- 0019  In-app purchase value and TikTok Shop gross revenue
--
--   metric_daily / metric_intraday
--     app_purchase_value_minor  TikTok "Purchase value (app)"  (total_purchase_value)
--     shop_revenue_minor        TikTok "Gross revenue (Shop)"  (total_onsite_shopping_value)
--     Minor units of the account currency; NULL = not fetched / not provided.
--     purchase_value_minor stays the WEBSITE purchase value.
--   client_economics.value_sources
--     which of website / app / shop count as the client's purchase value (and
--     ROAS). Only those are requested from TikTok. Default: website.
--     gross_margin_pct becomes optional (a row may hold only the sources).
--   reconciliation_checks.metric may also be app_purchase_value / shop_revenue.
-- =============================================================================

alter table public.metric_daily
  add column app_purchase_value_minor bigint check (app_purchase_value_minor >= 0),
  add column shop_revenue_minor       bigint check (shop_revenue_minor >= 0);
alter table public.metric_intraday
  add column app_purchase_value_minor bigint check (app_purchase_value_minor >= 0),
  add column shop_revenue_minor       bigint check (shop_revenue_minor >= 0);

alter table public.reconciliation_checks drop constraint reconciliation_checks_metric_check;
alter table public.reconciliation_checks add constraint reconciliation_checks_metric_check
  check (metric in ('spend', 'impressions', 'clicks', 'conversions', 'purchase_value', 'app_purchase_value', 'shop_revenue'));

alter table public.client_economics alter column gross_margin_pct drop not null;
alter table public.client_economics
  add column value_sources text[] not null default '{website}'
    check (cardinality(value_sources) between 1 and 3 and value_sources <@ array['website', 'app', 'shop']);
