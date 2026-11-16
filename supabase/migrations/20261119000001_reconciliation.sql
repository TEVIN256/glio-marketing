-- =============================================================================
-- 0004  Reconciliation checks (M3)
--
-- After a sync, Glio asks the platform for its OWN account-level totals for
-- the same dates and compares them with the sum of the daily rows we stored.
-- One row per (check, metric):
--
--   ours        what Glio stored (sum of metric_daily), in minor units for spend
--   theirs      what the platform reported for the account, same units
--   drift_ppm   |ours - theirs| / theirs, in parts per million (exact integer)
--   status      ok             drift <= threshold (default 5000 ppm = 0.5%)
--               drift          drift >  threshold  -> surfaced to the user
--               not_comparable a side is missing ("not provided by platform",
--                              or some of our daily rows lack the metric)
--
-- Checks are a log: rows can't be updated or deleted directly (only via the
-- ad-account cascade on account/workspace deletion). The platform's totals
-- response is archived in raw_platform_payloads and referenced as evidence.
--
-- reconciliation_latest: newest check per ad account + metric, for the UI.
-- It runs with the caller's permissions (security_invoker), so RLS applies.
-- =============================================================================

create table public.reconciliation_checks (
  id                  bigint generated always as identity primary key,
  check_id            uuid not null,                    -- groups the metrics of one check
  workspace_id        uuid not null,
  client_id           uuid not null,
  ad_account_id       uuid not null,
  platform            text not null,
  sync_run_id         uuid references public.sync_runs (id) on delete cascade,
  date_from           date not null,
  date_to             date not null,
  metric              text not null check (metric in ('spend', 'impressions', 'clicks', 'conversions')),
  unit                text not null check (unit in ('minor_units', 'count', 'decimal')),
  currency            char(3),                          -- set for spend
  ours                numeric,
  theirs              numeric,
  drift_ppm           bigint check (drift_ppm >= 0),
  threshold_ppm       integer not null check (threshold_ppm >= 0),
  status              text not null check (status in ('ok', 'drift', 'not_comparable')),
  note                text,
  platform_payload_id bigint not null references public.raw_platform_payloads (id),
  checked_at          timestamptz not null default now(),
  check (date_to >= date_from),
  check (status <> 'drift' or drift_ppm is not null),
  unique (check_id, metric),
  foreign key (workspace_id, client_id, ad_account_id)
    references public.ad_accounts (workspace_id, client_id, id) on delete cascade
);
create index reconciliation_checks_account_idx
  on public.reconciliation_checks (ad_account_id, metric, checked_at desc);

-- Generic "log table" guard: no updates, no direct deletes, no truncate;
-- deletes cascaded from a parent row (pg_trigger_depth() > 1) are allowed.
create function public.block_mutation_except_cascade() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception '% is a log and cannot be changed (% blocked)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;
revoke all on function public.block_mutation_except_cascade() from public, anon, authenticated;

create trigger reconciliation_checks_no_update before update on public.reconciliation_checks
  for each row execute function public.block_mutation_except_cascade();
create trigger reconciliation_checks_no_direct_delete before delete on public.reconciliation_checks
  for each row execute function public.block_mutation_except_cascade();
create trigger reconciliation_checks_no_truncate before truncate on public.reconciliation_checks
  for each statement execute function public.block_mutation_except_cascade();

alter table public.reconciliation_checks enable row level security;

create policy reconciliation_checks_select on public.reconciliation_checks for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
-- no insert/update/delete policies: only the server writes checks

create view public.reconciliation_latest with (security_invoker = true) as
  select distinct on (ad_account_id, metric)
         workspace_id, client_id, ad_account_id, platform, metric, unit, currency,
         date_from, date_to, ours, theirs, drift_ppm, threshold_ppm, status, note,
         platform_payload_id, check_id, checked_at
  from public.reconciliation_checks
  order by ad_account_id, metric, checked_at desc, id desc;

revoke all on public.reconciliation_checks, public.reconciliation_latest from anon, authenticated;
grant select on public.reconciliation_checks, public.reconciliation_latest to authenticated;
grant select, insert, delete on public.reconciliation_checks to service_role;
grant select on public.reconciliation_latest to service_role;
grant usage, select on all sequences in schema public to service_role;
