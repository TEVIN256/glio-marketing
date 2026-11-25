-- =============================================================================
-- 0014  Purchase value (for return on ad spend)
--
--   metric_daily.purchase_value_minor
--       the platform's reported purchase value for the day, in minor units of
--       the ad account's currency (TikTok: website purchase value). NULL =
--       not provided (older rows, or the platform sent no value). ROAS is
--       computed from this and spend; it is never stored.
--   reconciliation_checks.metric
--       may now also be 'purchase_value' (checked against the platform's
--       account totals like spend).
-- =============================================================================

alter table public.metric_daily
  add column purchase_value_minor bigint check (purchase_value_minor >= 0);

alter table public.reconciliation_checks drop constraint reconciliation_checks_metric_check;
alter table public.reconciliation_checks add constraint reconciliation_checks_metric_check
  check (metric in ('spend', 'impressions', 'clicks', 'conversions', 'purchase_value'));
